/// <reference lib="webworker" />
// Hype Intro analysis worker: feature extraction, excitement scoring and
// highlight selection all happen off the main thread. Audio stays in-browser.
import {
  computeExcitement,
  extractFeatures,
  replaceSegment,
  selectSegments,
  FRAME_SECONDS,
  type FeatureSet,
  type HypeSegment,
} from "./analysis-core";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const post = (
  msg: WorkerResponse,
  transfer?: Transferable[],
): void =>
  (self as unknown as { postMessage: (m: WorkerResponse, t?: Transferable[]) => void }).postMessage(
    msg,
    transfer,
  );

let fs: FeatureSet | null = null;
let scores: Float32Array | null = null;
let segments: HypeSegment[] = [];
let videoDuration = 0;

function buildWaveform(samples: Float32Array, buckets: number) {
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const size = Math.max(1, Math.floor(samples.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let lo = 0;
    let hi = 0;
    const off = b * size;
    const end = Math.min(samples.length, off + size);
    for (let i = off; i < end; i++) {
      const s = samples[i] ?? 0;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === "analyze") {
      videoDuration = msg.videoDuration;
      const samples = new Float32Array(msg.samples);
      fs = extractFeatures(samples, msg.sampleRate, (r) =>
        post({ type: "progress", reqId: msg.reqId, value: r * 0.9 }),
      );
      scores = computeExcitement(fs, { pitchWeight: msg.pitchWeight });
      const result = selectSegments(
        fs,
        scores,
        { mode: msg.mode, targetDuration: msg.targetDuration, videoDuration },
      );
      segments = result;
      const waveform = buildWaveform(samples, 1600);
      const scoresCopy = scores.slice();
      post(
        {
          type: "done",
          reqId: msg.reqId,
          segments: result,
          scores: scoresCopy,
          waveform,
          frameRate: 1 / FRAME_SECONDS,
          analyzedDuration: fs.frameCount * FRAME_SECONDS,
        },
        [scoresCopy.buffer, waveform.min.buffer, waveform.max.buffer],
      );
      return;
    }

    // reselect
    if (!fs || !scores) {
      post({ type: "error", reqId: msg.reqId, message: "Run the analysis again first." });
      return;
    }
    scores = computeExcitement(fs, { pitchWeight: msg.pitchWeight });
    let result: HypeSegment[];
    if (msg.replaceIndex != null) {
      result = replaceSegment(fs, scores, segments, msg.replaceIndex);
    } else if (msg.regenerate) {
      result = selectSegments(
        fs,
        scores,
        { mode: msg.mode, targetDuration: msg.targetDuration, videoDuration },
        segments,
      );
      if (result.length === 0 || result.length < Math.min(2, segments.length)) {
        result = selectSegments(fs, scores, {
          mode: msg.mode,
          targetDuration: msg.targetDuration,
          videoDuration,
        });
      }
    } else {
      result = selectSegments(fs, scores, {
        mode: msg.mode,
        targetDuration: msg.targetDuration,
        videoDuration,
      });
    }
    segments = result;
    const scoresCopy = scores.slice();
    post(
      {
        type: "done",
        reqId: msg.reqId,
        segments: result,
        scores: scoresCopy,
        frameRate: 1 / FRAME_SECONDS,
        analyzedDuration: fs.frameCount * FRAME_SECONDS,
      },
      [scoresCopy.buffer],
    );
  } catch (error) {
    post({
      type: "error",
      reqId: msg.reqId,
      message: error instanceof Error ? error.message : "Audio analysis failed.",
    });
  }
};
