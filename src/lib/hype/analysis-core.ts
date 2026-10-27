// Pure audio-analysis and highlight-selection logic for the Hype Intro tool.
// No DOM or browser APIs — shared by the Web Worker and unit tests.

export const FRAME_SECONDS = 0.1;
export const HARD_MAX_SEGMENT = 30;

const MARGIN_FRAMES = 10; // keep >=1 s between montage candidates
const SNAP_FRAMES = 5; // prefer silence for cut points within ±0.5 s

export type FrameFeatures = {
  rmsDb: number;
  pitchHz: number;
  pitchConf: number;
  variation: number; // semitones of pitch change vs the previous pitched frame
  centroidHz: number;
};

export type FeatureSet = {
  features: FrameFeatures[];
  valid: Uint8Array;
  frameCount: number;
};

export type HypeSegment = { start: number; dur: number; score: number };

export type SelectionRequest = {
  mode: "best" | "montage";
  targetDuration: number;
  videoDuration: number;
};

export type Waveform = { min: Float32Array; max: Float32Array };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- features

/** Iterative radix-2 FFT, in place. Length must be a power of two. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tre = re[i]!;
      re[i] = re[j]!;
      re[j] = tre;
      const tim = im[i]!;
      im[i] = im[j]!;
      im[j] = tim;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]!;
        const aIm = im[i + k]!;
        const bRe = re[i + k + half]! * curRe - im[i + k + half]! * curIm;
        const bIm = re[i + k + half]! * curIm + im[i + k + half]! * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Simplified YIN pitch estimate on a decimated frame. */
function yinPitch(decimated: Float32Array, sampleRate: number): { hz: number; conf: number } {
  const window = Math.min(512, Math.floor(decimated.length / 2));
  if (window < 64) return { hz: 0, conf: 0 };
  const tauMin = Math.max(2, Math.floor(sampleRate / 1000)); // up to ~1 kHz
  const tauMax = Math.min(window - 1, Math.ceil(sampleRate / 60)); // down to ~60 Hz
  if (tauMax <= tauMin) return { hz: 0, conf: 0 };

  const diff = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < window; j++) {
      const d = (decimated[j] ?? 0) - (decimated[j + tau] ?? 0);
      sum += d * d;
    }
    diff[tau] = sum;
  }
  const cmnd = new Float32Array(tauMax + 1);
  let running = 0;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += diff[tau]!;
    cmnd[tau] = running > 0 ? (diff[tau]! * (tau - tauMin + 1)) / running : 1;
  }

  let tauEst = -1;
  const threshold = 0.2;
  for (let tau = tauMin + 1; tau <= tauMax; tau++) {
    if (cmnd[tau]! < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1]! < cmnd[tau]!) tau++;
      tauEst = tau;
      break;
    }
  }
  if (tauEst < 0) {
    let best = tauMin;
    for (let tau = tauMin; tau <= tauMax; tau++) if (cmnd[tau]! < cmnd[best]!) best = tau;
    if (cmnd[best]! > 0.5) return { hz: 0, conf: clamp(1 - cmnd[best]!, 0, 1) };
    tauEst = best;
  }

  let betterTau = tauEst;
  if (tauEst > tauMin && tauEst < tauMax) {
    const s0 = cmnd[tauEst - 1]!;
    const s1 = cmnd[tauEst]!;
    const s2 = cmnd[tauEst + 1]!;
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-12) betterTau = tauEst + (s2 - s0) / denom;
  }
  const hz = sampleRate / betterTau;
  const conf = clamp(1 - cmnd[tauEst]!, 0, 1);
  if (!Number.isFinite(hz) || hz <= 0 || hz > 1000) return { hz: 0, conf };
  return { hz, conf };
}

/**
 * Extracts per-100 ms frame features: RMS (dB), YIN pitch + confidence,
 * spectral centroid and pitch variation. Marks silent / invalid frames.
 */
export function extractFeatures(
  samples: Float32Array,
  sampleRate = 16000,
  onProgress?: (ratio: number) => void,
): FeatureSet {
  const frameLen = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frameCount = Math.max(0, Math.floor(samples.length / frameLen));
  const features: FrameFeatures[] = [];

  const fftSize = 2048;
  const windowFn = new Float32Array(frameLen);
  for (let i = 0; i < frameLen; i++) {
    windowFn[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, frameLen - 1));
  }
  const halfLen = frameLen >> 1;
  const halfRate = sampleRate / 2;
  const binHz = sampleRate / fftSize;

  for (let f = 0; f < frameCount; f++) {
    const off = f * frameLen;

    let sumSq = 0;
    for (let i = 0; i < frameLen; i++) {
      const s = samples[off + i] ?? 0;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / frameLen);
    const rmsDb = 20 * Math.log10(rms + 1e-9);

    const dec = new Float32Array(halfLen);
    for (let i = 0; i < halfLen; i++) {
      dec[i] = ((samples[off + 2 * i] ?? 0) + (samples[off + 2 * i + 1] ?? 0)) / 2;
    }
    const pitch = yinPitch(dec, halfRate);

    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    for (let i = 0; i < frameLen; i++) re[i] = (samples[off + i] ?? 0) * windowFn[i]!;
    fft(re, im);
    let num = 0;
    let den = 0;
    for (let k = 1; k < fftSize / 2; k++) {
      const mag = Math.hypot(re[k]!, im[k]!);
      num += mag * k * binHz;
      den += mag;
    }
    const centroidHz = den > 1e-9 ? num / den : 0;

    features.push({ rmsDb, pitchHz: pitch.hz, pitchConf: pitch.conf, variation: 0, centroidHz });
    if (onProgress && f % 64 === 0) onProgress(f / Math.max(1, frameCount));
  }

  // Silence threshold from robust stats of the audio itself.
  const valid = new Uint8Array(frameCount);
  const dbs = features.map((x) => x.rmsDb).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (dbs.length > 0) {
    const median = dbs[Math.floor(dbs.length / 2)]!;
    const floor = dbs[Math.floor(dbs.length * 0.1)]!;
    const spread = median - floor;
    const threshold =
      spread > 20 ? Math.max(-55, median - 30, floor + 12) : Math.max(-55, median - 30);
    for (let i = 0; i < frameCount; i++) {
      const fx = features[i]!;
      valid[i] =
        Number.isFinite(fx.rmsDb) && fx.rmsDb > threshold && fx.centroidHz > 0 ? 1 : 0;
    }
  }

  // Pitch variation (semitone change between consecutive pitched frames).
  let prevHz = 0;
  for (let i = 0; i < frameCount; i++) {
    const fx = features[i]!;
    if (valid[i] && fx.pitchConf > 0.5 && fx.pitchHz > 0) {
      if (prevHz > 0) fx.variation = Math.min(24, Math.abs(12 * Math.log2(fx.pitchHz / prevHz)));
      prevHz = fx.pitchHz;
    }
  }

  onProgress?.(1);
  return { features, valid, frameCount };
}

export function countValid(fs: FeatureSet): number {
  let count = 0;
  for (let i = 0; i < fs.valid.length; i++) count += fs.valid[i] ?? 0;
  return count;
}

// --------------------------------------------------------------- excitement

function normalizeInto(
  target: Float32Array,
  indices: number[],
  value: (i: number) => number,
  logScale: boolean,
): void {
  const vals: number[] = [];
  for (const i of indices) {
    let v = value(i);
    if (logScale) v = Math.log2(Math.max(v, 1e-3));
    target[i] = v;
    vals.push(v);
  }
  if (vals.length === 0) return;
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor((vals.length - 1) * 0.05)] ?? 0;
  const hi = vals[Math.floor((vals.length - 1) * 0.95)] ?? 1;
  const span = hi - lo;
  for (const i of indices) {
    target[i] = span > 1e-6 ? clamp((target[i]! - lo) / span, 0, 1) : 0.5;
  }
}

/**
 * Per-frame excitement score in [0, 1]. `pitchWeight` (0..1) blends the
 * pitch family (pitch height, variation, spectral centroid) against loudness.
 */
export function computeExcitement(fs: FeatureSet, opts: { pitchWeight: number }): Float32Array {
  const n = fs.frameCount;
  const scores = new Float32Array(n);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (fs.valid[i]) idx.push(i);
  if (idx.length === 0) return scores;
  const w = clamp(opts.pitchWeight, 0, 1);

  const loud = new Float32Array(n);
  normalizeInto(loud, idx, (i) => fs.features[i]!.rmsDb, false);

  const pitch = new Float32Array(n);
  const pitched = idx.filter((i) => fs.features[i]!.pitchHz > 0 && fs.features[i]!.pitchConf > 0.3);
  if (pitched.length >= 4) {
    normalizeInto(pitch, pitched, (i) => fs.features[i]!.pitchHz, true);
    for (const i of pitched) {
      const conf = clamp(fs.features[i]!.pitchConf * 1.25, 0, 1);
      pitch[i] = pitch[i]! * (0.4 + 0.6 * conf);
    }
  }

  const variation = new Float32Array(n);
  normalizeInto(variation, idx, (i) => fs.features[i]!.variation, false);

  const centroid = new Float32Array(n);
  const bright = idx.filter((i) => fs.features[i]!.centroidHz > 0);
  if (bright.length >= 4) normalizeInto(centroid, bright, (i) => fs.features[i]!.centroidHz, true);

  for (const i of idx) {
    const pitchScore = 0.45 * pitch[i]! + 0.3 * variation[i]! + 0.25 * centroid[i]!;
    scores[i] = (1 - w) * loud[i]! + w * pitchScore;
  }

  // Light 3-frame smoothing so single noisy frames don't dominate cut points.
  const smoothed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = scores[i - 1] ?? 0;
    const b = scores[i] ?? 0;
    const c = scores[i + 1] ?? 0;
    smoothed[i] = (a + b + c) / 3;
  }
  return smoothed;
}

// ---------------------------------------------------------------- selection

function windowMean(scores: Float32Array, start: number, len: number): number {
  let sum = 0;
  for (let i = start; i < start + len; i++) sum += scores[i] ?? 0;
  return len > 0 ? sum / len : 0;
}

/**
 * Best sliding window by mean excitement, penalising windows that cover many
 * silent/invalid frames. Skips any window overlapping an avoid range.
 */
function bestWindow(
  fs: FeatureSet,
  scores: Float32Array,
  win: number,
  step: number,
  avoid: Array<readonly [number, number]>,
): number | null {
  const n = fs.frameCount;
  if (win <= 0 || win > n) return null;
  const prefix = new Float64Array(n + 1);
  const validPrefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i]! + (scores[i] ?? 0);
    validPrefix[i + 1] = validPrefix[i]! + (fs.valid[i] ? 1 : 0);
  }
  let best: number | null = null;
  let bestScore = -Infinity;
  for (let s = 0; s + win <= n; s += step) {
    let blocked = false;
    for (const [a, b] of avoid) {
      if (s < b && s + win > a) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const mean = (prefix[s + win]! - prefix[s]!) / win;
    const validRatio = (validPrefix[s + win]! - validPrefix[s]!) / win;
    const score = mean * (0.6 + 0.4 * validRatio);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** Moves an edge to the quietest frame within ±0.5 s (silence-preferred cuts). */
function snapEdge(scores: Float32Array, frame: number, maxFrames: number): number {
  let best = frame;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let d = -SNAP_FRAMES; d <= SNAP_FRAMES; d++) {
    const f = frame + d;
    if (f < 0 || f >= maxFrames) continue;
    const s = scores[f] ?? 1;
    if (s < bestScore) {
      bestScore = s;
      best = f;
    }
  }
  return best;
}

function snapSegment(
  scores: Float32Array,
  startFrame: number,
  len: number,
  maxFrames: number,
): { start: number; len: number } {
  const start = snapEdge(scores, startFrame, maxFrames);
  const end = snapEdge(scores, startFrame + len, maxFrames);
  let s = start;
  let e = end;
  if (e - s < Math.round(len * 0.5)) {
    s = startFrame;
    e = startFrame + len;
  }
  const cap = Math.round(HARD_MAX_SEGMENT / FRAME_SECONDS);
  const lenFrames = Math.min(Math.max(1, e - s), cap, Math.max(1, maxFrames - s));
  return { start: s, len: lenFrames };
}

/** Sorts chunks chronologically and resolves overlaps by shifting/truncating. */
function finalizeChronological(
  chunks: Array<{ start: number; len: number }>,
  maxFrames: number,
): Array<{ start: number; len: number }> {
  const minLen = Math.round(2 / FRAME_SECONDS);
  const sorted = [...chunks].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; len: number }> = [];
  let prevEnd = -1;
  for (const c of sorted) {
    const start = Math.max(c.start, prevEnd + 1);
    const len = Math.min(c.len, maxFrames - start);
    if (start < 0 || len < minLen) continue;
    out.push({ start, len });
    prevEnd = start + len;
  }
  return out;
}

function toSegments(
  chunks: Array<{ start: number; len: number }>,
  scores: Float32Array,
): HypeSegment[] {
  return chunks.map((c) => ({
    start: c.start * FRAME_SECONDS,
    dur: c.len * FRAME_SECONDS,
    score: windowMean(scores, c.start, c.len),
  }));
}

/** Fallback for silent / unusable audio: the first portion, capped at 30 s. */
function fallbackSegments(mode: "best" | "montage", target: number, bound: number): HypeSegment[] {
  if (bound <= 0) return [];
  const cap = Math.min(target, HARD_MAX_SEGMENT, bound);
  if (cap < 0.5) return [{ start: 0, dur: Math.min(bound, HARD_MAX_SEGMENT), score: 0 }];
  if (mode === "best" || cap < 6) return [{ start: 0, dur: cap, score: 0 }];
  const count = clamp(Math.round(cap / 6), 2, 5);
  const chunk = cap / count;
  return Array.from({ length: count }, (_, i) => ({ start: i * chunk, dur: chunk, score: 0 }));
}

/**
 * Selects highlight segments.
 * - best:    one continuous segment of ~targetDuration (hard 30 s cap).
 * - montage: 2–5 non-overlapping, chronological segments (target/6 each,
 *            clamped to 3–8 s) whose total ≈ targetDuration.
 * `avoid` excludes regions (used by regenerate).
 */
export function selectSegments(
  fs: FeatureSet,
  scores: Float32Array,
  req: SelectionRequest,
  avoid: HypeSegment[] = [],
): HypeSegment[] {
  const frameCount = fs.frameCount;
  const analyzed = frameCount * FRAME_SECONDS;
  const bound = req.videoDuration > 0 ? Math.min(analyzed, req.videoDuration) : analyzed;
  const target = clamp(req.targetDuration, 3, HARD_MAX_SEGMENT);
  if (frameCount === 0 || bound < 1 || countValid(fs) === 0) {
    return fallbackSegments(req.mode, target, bound);
  }
  const maxFrames = Math.max(1, Math.round(bound / FRAME_SECONDS));
  const avoidRanges = avoid.map(
    (s) =>
      [
        Math.round(s.start / FRAME_SECONDS) - MARGIN_FRAMES,
        Math.round((s.start + s.dur) / FRAME_SECONDS) + MARGIN_FRAMES,
      ] as const,
  );

  if (req.mode === "best") {
    const win = clamp(Math.round(target / FRAME_SECONDS), 1, maxFrames);
    const idx = bestWindow(fs, scores, win, 2, avoidRanges);
    if (idx == null) return fallbackSegments(req.mode, target, bound);
    const snapped = snapSegment(scores, idx, win, maxFrames);
    return toSegments(finalizeChronological([snapped], maxFrames), scores);
  }

  const count = clamp(Math.round(target / 6), 2, 5);
  const segLen = clamp(
    Math.round(target / count / FRAME_SECONDS),
    Math.round(3 / FRAME_SECONDS),
    Math.round(8 / FRAME_SECONDS),
  );
  const picked: number[] = [];
  const pickedRanges: Array<readonly [number, number]> = [];
  while (picked.length < count) {
    const idx = bestWindow(fs, scores, segLen, 3, [...avoidRanges, ...pickedRanges]);
    if (idx == null) break;
    picked.push(idx);
    pickedRanges.push([idx - MARGIN_FRAMES, idx + segLen + MARGIN_FRAMES]);
  }
  if (picked.length >= 2) {
    const chunks = picked.map((s) => snapSegment(scores, s, segLen, maxFrames));
    const finalized = finalizeChronological(chunks, maxFrames);
    if (finalized.length >= 1) return toSegments(finalized, scores);
  }
  return fallbackSegments("montage", target, bound);
}

/** Swaps segment `index` for the best window that avoids all other segments. */
export function replaceSegment(
  fs: FeatureSet,
  scores: Float32Array,
  current: HypeSegment[],
  index: number,
): HypeSegment[] {
  const target = current[index];
  if (!target) return current;
  const frameCount = Math.max(1, fs.frameCount);
  const win = clamp(
    Math.round(target.dur / FRAME_SECONDS),
    1,
    Math.round(HARD_MAX_SEGMENT / FRAME_SECONDS),
  );
  const avoid = current
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i !== index)
    .map(
      ({ s }) =>
        [
          Math.round(s.start / FRAME_SECONDS) - MARGIN_FRAMES,
          Math.round((s.start + s.dur) / FRAME_SECONDS) + MARGIN_FRAMES,
        ] as const,
    );
  const idx = bestWindow(fs, scores, win, 2, avoid);
  if (idx == null) return current;
  const chunks = current.map((s, i) =>
    i === index
      ? snapSegment(scores, idx, win, frameCount)
      : {
          start: Math.round(s.start / FRAME_SECONDS),
          len: Math.max(1, Math.round(s.dur / FRAME_SECONDS)),
        },
  );
  return toSegments(finalizeChronological(chunks, frameCount), scores);
}
