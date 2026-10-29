import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCcw, Shuffle, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import { VideoPane } from "@/components/tools/video-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { downloadFiles } from "@/lib/download";
import {
  abortFFmpeg,
  deleteTemp,
  FFmpegCancelledError,
  looksLikeMp4,
  readOutput,
  runFFmpeg,
  safeInputName,
  writeInputOnce,
} from "@/lib/ffmpeg-client";
import { useEngineBusy } from "@/hooks/use-engine-busy";
import { HARD_MAX_SEGMENT } from "@/lib/hype/analysis-core";
import type { WorkerRequest, WorkerResponse } from "@/lib/hype/protocol";
import { formatTimecode } from "@/lib/format";

type Props = { file: File; fileUrl: string; duration: number | null };
type Mode = "best" | "montage";
type HypeSegment = { start: number; dur: number; score: number };
type Analysis = {
  segments: HypeSegment[];
  scores: Float32Array;
  waveform: { min: Float32Array; max: Float32Array };
  frameRate: number;
  analyzedDuration: number;
};
type Stage = "idle" | "extract" | "analyze" | "ready" | "render";

const PCM_NAME = "hype-audio.pcm";
const OUT_NAME = "hype-output.mp4";
const SAMPLE_RATE = 16000;
const MAX_ANALYSIS_SECONDS = 30 * 60;
const MONTAGE_TARGETS = [10, 15, 20, 30];
const ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-sn",
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Raw little-endian f32 PCM bytes -> Float32Array (alignment-safe copy). */
function toFloat32(bytes: Uint8Array, sampleCount: number): Float32Array {
  const out = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 4);
  for (let i = 0; i < sampleCount; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Plain ArrayBuffer copy, safe to transfer to the worker. */
function toArrayBuffer(view: Float32Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export function HypeTool({ file, fileUrl, duration }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(1);
  const cancelledRef = useRef(false);

  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [mode, setMode] = useState<Mode>("montage");
  const [bestDuration, setBestDuration] = useState(15);
  const [montageTarget, setMontageTarget] = useState(15);
  const [weight, setWeight] = useState(50);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; blob: Blob; name: string } | null>(null);

  const inputName = safeInputName(file);
  const engineBusy = useEngineBusy();
  const targetDuration =
    mode === "best" ? clamp(Math.round(bestDuration * 10) / 10, 3, HARD_MAX_SEGMENT) : montageTarget;
  const busy = stage === "extract" || stage === "analyze" || stage === "render";

  const cleanup = useCallback(() => {
    cancelledRef.current = true;
    reqIdRef.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
    setAnalysis(null);
    setStage("idle");
    setProgress(0);
    setStatusText("");
    setNote(null);
    void deleteTemp(PCM_NAME);
  }, []);

  // Reset everything when the input file changes or the tool unmounts.
  useEffect(() => {
    return () => {
      cleanup();
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
    };
  }, [file, cleanup]);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL("../../lib/hype/hype-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        if (msg.reqId === reqIdRef.current) setProgress(40 + msg.value * 55);
        return;
      }
      if (msg.type === "error") {
        if (msg.reqId !== reqIdRef.current) return;
        toast.error(msg.message);
        setStage((s) => (s === "analyze" ? "idle" : s));
        setProgress(0);
        setStatusText("");
        return;
      }
      if (msg.reqId !== reqIdRef.current) return;
      setAnalysis((prev) => ({
        segments: msg.segments,
        scores: msg.scores,
        frameRate: msg.frameRate,
        analyzedDuration: msg.waveform ? msg.analyzedDuration : (prev?.analyzedDuration ?? 0),
        waveform: msg.waveform ?? (prev?.waveform ?? { min: new Float32Array(0), max: new Float32Array(0) }),
      }));
      setStage("ready");
      setProgress(0);
      setStatusText("");
    };
    worker.onerror = () => {
      toast.error("Audio analysis failed to start. Try again.");
      setStage((s) => (s === "analyze" ? "idle" : s));
      setProgress(0);
      setStatusText("");
    };
    workerRef.current = worker;
    return worker;
  }, []);

  const postReselect = useCallback(
    (opts: { regenerate: boolean; replaceIndex: number | null }) => {
      if (!workerRef.current || stage !== "ready") return;
      const id = ++reqIdRef.current;
      workerRef.current.postMessage({
        type: "reselect",
        mode,
        targetDuration,
        pitchWeight: weight / 100,
        regenerate: opts.regenerate,
        replaceIndex: opts.replaceIndex,
        reqId: id,
      } satisfies WorkerRequest);
    },
    [mode, targetDuration, weight, stage],
  );

  // Live re-selection when the mode, duration or weighting changes.
  useEffect(() => {
    if (stage !== "ready" || !workerRef.current) return;
    const id = ++reqIdRef.current;
    workerRef.current.postMessage({
      type: "reselect",
      mode,
      targetDuration,
      pitchWeight: weight / 100,
      regenerate: false,
      replaceIndex: null,
      reqId: id,
    } satisfies WorkerRequest);
  }, [mode, targetDuration, weight, stage]);

  const analyze = async () => {
    if (busy) return;
    cancelledRef.current = false;
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    setNote(null);
    setAnalysis(null);
    setStage("extract");
    setProgress(0);
    setStatusText("Extracting audio…");
    try {
      await writeInputOnce(inputName, file);
      await runFFmpeg(
        [
          "-i", inputName,
          "-vn", "-sn", "-dn",
          "-ac", "1", "-ar", String(SAMPLE_RATE),
          "-f", "f32le", "-acodec", "pcm_f32le",
          "-y", PCM_NAME,
        ],
        (p) => setProgress(p * 40),
      );
      const bytes = await readOutput(PCM_NAME);
      await deleteTemp(PCM_NAME);
      if (cancelledRef.current) {
        setStage("idle");
        setProgress(0);
        setStatusText("");
        return;
      }
      const sampleCount = Math.floor(bytes.byteLength / 4);
      if (sampleCount < SAMPLE_RATE) {
        throw new Error("No usable audio track was found in this video.");
      }
      let samples = toFloat32(bytes, sampleCount);
      if (sampleCount > MAX_ANALYSIS_SECONDS * SAMPLE_RATE) {
        samples = samples.slice(0, MAX_ANALYSIS_SECONDS * SAMPLE_RATE);
        setNote("Long video — analyzing the first 30 minutes.");
      }
      setStage("analyze");
      setStatusText("Finding the hype…");
      setProgress(40);
      const id = ++reqIdRef.current;
      ensureWorker().postMessage(
        {
          type: "analyze",
          samples: toArrayBuffer(samples),
          sampleRate: SAMPLE_RATE,
          mode,
          targetDuration,
          pitchWeight: weight / 100,
          videoDuration: duration ?? 0,
          reqId: id,
        } satisfies WorkerRequest,
        [samples.buffer],
      );
    } catch (error) {
      if (error instanceof FFmpegCancelledError) {
        toast.message("Cancelled.");
      } else {
        console.error(error);
        toast.error(
          error instanceof Error ? error.message : "Something went wrong while reading the audio.",
        );
      }
      setStage("idle");
      setProgress(0);
      setStatusText("");
    }
  };

  const cancel = () => {
    cancelledRef.current = true;
    reqIdRef.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
    // Interrupt any in-flight FFmpeg job (audio extraction) too.
    abortFFmpeg();
    setStage(analysis ? "ready" : "idle");
    setProgress(0);
    setStatusText("");
  };

  const updateSegment = (index: number, patch: Partial<HypeSegment>) =>
    setAnalysis((prev) =>
      prev
        ? { ...prev, segments: prev.segments.map((s, i) => (i === index ? { ...s, ...patch } : s)) }
        : prev,
    );

  const removeSegment = (index: number) =>
    setAnalysis((prev) =>
      prev ? { ...prev, segments: prev.segments.filter((_, i) => i !== index) } : prev,
    );

  const seekTo = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(time, video.duration || time);
  };

  const render = async () => {
    if (!analysis || analysis.segments.length === 0 || stage === "render") return;
    setStage("render");
    setProgress(0);
    setStatusText("Rendering…");
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
    const tempNames: string[] = [];
    try {
      await writeInputOnce(inputName, file);
      const segs = analysis.segments.map((s) => ({
        start: Math.max(0, s.start),
        dur: clamp(s.dur, 0.6, HARD_MAX_SEGMENT),
      }));

      if (segs.length === 1) {
        const seg = segs[0]!;
        const fadeOut = Math.max(0, seg.dur - 0.3);
        const vf =
          seg.dur > 0.6
            ? `fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.3`
            : "fade=t=in:st=0:d=0.3";
        const af =
          seg.dur > 0.6
            ? `afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeOut.toFixed(2)}:d=0.3`
            : "afade=t=in:st=0:d=0.3";
        setStatusText("Cutting your hype moment…");
        await runFFmpeg(
          [
            "-ss", seg.start.toFixed(3),
            "-i", inputName,
            "-t", seg.dur.toFixed(3),
            "-vf", vf,
            "-af", af,
            ...ENCODE,
            "-y", OUT_NAME,
          ],
          setProgress,
        );
      } else {
        const overlap = 0.3;
        const n = segs.length;
        const cutDur = segs.map((s, i) =>
          i < n - 1 ? Math.min(s.dur, 8.5) + overlap : Math.min(s.dur, 8.5),
        );
        for (let i = 0; i < n; i++) {
          const seg = segs[i]!;
          const d = cutDur[i]!;
          setStatusText(`Cutting clip ${i + 1} of ${n}…`);
          const vfParts: string[] = [];
          const afParts: string[] = [];
          if (i === 0) {
            vfParts.push("fade=t=in:st=0:d=0.3");
            afParts.push("afade=t=in:st=0:d=0.3");
          }
          if (i === n - 1 && d > 0.6) {
            const st = d - 0.3;
            vfParts.push(`fade=t=out:st=${st.toFixed(2)}:d=0.3`);
            afParts.push(`afade=t=out:st=${st.toFixed(2)}:d=0.3`);
          }
          const segName = `hype-seg-${i}.mp4`;
          tempNames.push(segName);
          const args = ["-ss", seg.start.toFixed(3), "-i", inputName, "-t", d.toFixed(3)];
          if (vfParts.length > 0) args.push("-vf", vfParts.join(","), "-af", afParts.join(","));
          args.push(...ENCODE, "-y", segName);
          await runFFmpeg(args, (p) => setProgress(((i + p) / (n + 1)) * 100));
        }
        setStatusText("Blending clips with crossfades…");
        const parts: string[] = [];
        let vLabel = "0:v";
        let aLabel = "0:a";
        let acc = 0;
        for (let k = 1; k < n; k++) {
          acc += cutDur[k - 1]!;
          const offset = acc - overlap * k;
          const vOut = `hypev${k}`;
          const aOut = `hypea${k}`;
          parts.push(
            `[${vLabel}][${k}:v]xfade=transition=fade:duration=0.3:offset=${offset.toFixed(3)}[${vOut}]`,
          );
          parts.push(`[${aLabel}][${k}:a]acrossfade=d=0.3[${aOut}]`);
          vLabel = vOut;
          aLabel = aOut;
        }
        const inputs = segs.flatMap((_, i) => ["-i", `hype-seg-${i}.mp4`]);
        await runFFmpeg(
          [
            ...inputs,
            "-filter_complex", parts.join(";"),
            "-map", `[${vLabel}]`,
            "-map", `[${aLabel}]`,
            ...ENCODE,
            "-y", OUT_NAME,
          ],
          (p) => setProgress(((n + p) / (n + 1)) * 100),
        );
      }

      tempNames.push(OUT_NAME);
      const data = await readOutput(OUT_NAME);
      if (!looksLikeMp4(data)) {
        throw new Error(
          "The export came out damaged. Please try again — if it keeps happening, try a different file.",
        );
      }
      const blob = new Blob([data as unknown as BlobPart], { type: "video/mp4" });
      const base =
        file.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").slice(0, 60) || "video";
      setResult({ url: URL.createObjectURL(blob), blob, name: `${base}-hype.mp4` });
      toast.success("Hype intro ready — download it below.");
    } catch (error) {
      if (error instanceof FFmpegCancelledError) {
        toast.message("Cancelled.");
      } else {
        console.error(error);
        toast.error(
          error instanceof Error ? error.message : "Something went wrong while rendering.",
        );
      }
    } finally {
      setStatusText("");
      setProgress(0);
      setStage("ready");
      await deleteTemp(...tempNames);
    }
  };

  const clearResult = () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <VideoPane src={fileUrl} videoRef={videoRef} />
        {analysis && (
          <HypeTimeline
            waveform={analysis.waveform}
            scores={analysis.scores}
            analyzedDuration={analysis.analyzedDuration}
            segments={analysis.segments}
            onSeek={seekTo}
          />
        )}
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="micro-label">Hype Intro</p>
          <p className="mt-1 text-xs text-muted-foreground">
            HyperSnip listens to the audio and cuts the most exciting moments. Everything is analyzed
            on your device.
          </p>

          {stage === "idle" && (
            <>
              {engineBusy && (
                <p className="text-center text-xs text-muted-foreground">
                  The video engine is busy with another tool — try again in a moment.
                </p>
              )}
              <Button className="mt-4 w-full" size="lg" onClick={analyze} disabled={engineBusy}>
                <Zap className="h-4 w-4" /> Find the hype
              </Button>
            </>
          )}

          {(stage === "extract" || stage === "analyze") && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {statusText} {Math.round(progress)}%
              </div>
              <Progress value={progress} />
              <Button variant="secondary" className="w-full" onClick={cancel}>
                Cancel
              </Button>
            </div>
          )}

          {(stage === "ready" || stage === "render") && analysis && (
            <>
              <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-border bg-background/40 p-1">
                {(["best", "montage"] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    disabled={busy}
                    onClick={() => setMode(m)}
                    className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                      mode === m
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m === "best" ? "Best Moment" : "Montage"}
                  </button>
                ))}
              </div>

              {mode === "best" ? (
                <label className="mt-3 block space-y-1">
                  <span className="micro-label">Length (s, max {HARD_MAX_SEGMENT})</span>
                  <Input
                    type="number"
                    step="0.5"
                    min={3}
                    max={HARD_MAX_SEGMENT}
                    value={bestDuration}
                    disabled={busy}
                    onChange={(e) => setBestDuration(clamp(Number(e.target.value) || 15, 3, HARD_MAX_SEGMENT))}
                    className="timecode"
                  />
                </label>
              ) : (
                <div className="mt-3 space-y-1">
                  <span className="micro-label">Total length</span>
                  <div className="grid grid-cols-4 gap-1">
                    {MONTAGE_TARGETS.map((t) => (
                      <button
                        key={t}
                        disabled={busy}
                        onClick={() => setMontageTarget(t)}
                        className={`timecode rounded-md border px-1 py-1.5 text-xs font-semibold transition-colors ${
                          montageTarget === t
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {t}s
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="micro-label">Loudness</span>
                  <span className="micro-label">Pitch</span>
                </div>
                <Slider
                  value={[weight]}
                  min={0}
                  max={100}
                  step={5}
                  disabled={busy}
                  onValueChange={(values) => setWeight(values[0] ?? 50)}
                  aria-label="Pitch versus loudness weighting"
                />
              </div>
            </>
          )}
        </div>

        {stage === "render" && (
          <div className="space-y-2 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {statusText} {Math.round(progress)}%
            </div>
            <Progress value={progress} />
            <Button variant="secondary" className="w-full" onClick={cancel}>
              Cancel
            </Button>
          </div>
        )}

        {stage === "ready" && analysis && analysis.segments.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="micro-label">Clips, in order</p>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => postReselect({ regenerate: true, replaceIndex: null })}>
                <RefreshCcw className="h-3.5 w-3.5" /> Regenerate
              </Button>
            </div>
            <div className="mt-3 space-y-1.5">
              {analysis.segments.map((seg, i) => (
                <div
                  key={`${seg.start}-${seg.dur}-${i}`}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-2 py-1.5"
                >
                  <span className="w-4 text-center text-xs font-semibold text-muted-foreground">
                    {i + 1}
                  </span>
                  <Input
                    type="number"
                    step="0.1"
                    min={0}
                    aria-label={`Clip ${i + 1} start`}
                    value={seg.start.toFixed(1)}
                    disabled={busy}
                    onChange={(e) => updateSegment(i, { start: Math.max(0, Number(e.target.value) || 0) })}
                    className="timecode h-7 flex-1 px-1.5"
                  />
                  <span className="text-xs text-muted-foreground">+</span>
                  <Input
                    type="number"
                    step="0.1"
                    min={0.5}
                    max={HARD_MAX_SEGMENT}
                    aria-label={`Clip ${i + 1} length`}
                    value={seg.dur.toFixed(1)}
                    disabled={busy}
                    onChange={(e) => updateSegment(i, { dur: clamp(Number(e.target.value) || 0.5, 0.5, HARD_MAX_SEGMENT) })}
                    className="timecode h-7 w-16 px-1.5"
                  />
                  <button
                    aria-label={`Replace clip ${i + 1} with next best`}
                    disabled={busy}
                    onClick={() => postReselect({ regenerate: false, replaceIndex: i })}
                    className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <Shuffle className="h-3.5 w-3.5" />
                  </button>
                  <button
                    aria-label={`Remove clip ${i + 1}`}
                    disabled={busy}
                    onClick={() => removeSegment(i)}
                    className="rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <p className="timecode mt-3 text-muted-foreground">
              Total:{" "}
              {formatTimecode(analysis.segments.reduce((sum, s) => sum + s.dur, 0))}
            </p>
            <Button className="mt-3 w-full" size="lg" onClick={render} disabled={busy || engineBusy}>
              <Zap className="h-4 w-4" />
              {busy ? "Rendering…" : `Render ${mode === "best" ? "best moment" : "montage"}`}
            </Button>
          </div>
        )}

        {note && <p className="text-xs text-muted-foreground">{note}</p>}

        {result ? (
          <div className="space-y-3 rounded-xl border border-primary/40 bg-card p-4">
            <p className="micro-label text-primary">Your hype intro is ready</p>
            <video src={result.url} controls className="w-full rounded-lg bg-black" />
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() => downloadFiles([{ name: result.name, data: result.blob }], "hypersnip.zip")}
              >
                <Download className="h-4 w-4" /> Download MP4
              </Button>
              <Button variant="secondary" onClick={clearResult}>
                <RefreshCcw className="h-4 w-4" /> Again
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type TimelineProps = {
  waveform: { min: Float32Array; max: Float32Array };
  scores: Float32Array;
  analyzedDuration: number;
  segments: HypeSegment[];
  onSeek: (time: number) => void;
};

/** Waveform + excitement timeline with the selected segments highlighted. */
function HypeTimeline({ waveform, scores, analyzedDuration, segments, onSeek }: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || analyzedDuration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const style = getComputedStyle(canvas);
    const primary = style.getPropertyValue("--primary").trim() || "#a3e635";
    const muted = style.getPropertyValue("--muted-foreground").trim() || "#8a8a8a";

    ctx.clearRect(0, 0, w, h);

    // Waveform envelope (upper area).
    const mid = h * 0.4;
    const amp = h * 0.32;
    const buckets = waveform.min.length;
    if (buckets > 0) {
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const b = Math.min(buckets - 1, Math.floor((x / w) * buckets));
        const lo = (waveform.min[b] ?? 0) * amp;
        const hi = (waveform.max[b] ?? 0) * amp;
        ctx.moveTo(x + 0.5, mid - hi);
        ctx.lineTo(x + 0.5, mid - lo);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Excitement curve (lower area).
    const n = scores.length;
    if (n > 0) {
      const baseY = h - 6;
      const curveH = h * 0.42;
      ctx.strokeStyle = primary;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= w; x++) {
        const f = Math.min(n - 1, Math.floor((x / w) * n));
        const s = scores[f] ?? 0;
        const y = baseY - s * curveH;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Selected segments.
    for (const seg of segments) {
      const x1 = (seg.start / analyzedDuration) * w;
      const x2 = ((seg.start + seg.dur) / analyzedDuration) * w;
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = primary;
      ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = primary;
      ctx.lineWidth = 1;
      ctx.strokeRect(x1 + 0.5, 0.5, Math.max(2, x2 - x1) - 1, h - 1);
      ctx.globalAlpha = 1;
    }

    // Time ticks.
    const tickStep = Math.max(1, Math.ceil(analyzedDuration / 8 / 5) * 5);
    ctx.fillStyle = muted;
    ctx.font = "10px ui-monospace, monospace";
    for (let t = 0; t <= analyzedDuration; t += tickStep) {
      const x = (t / analyzedDuration) * w;
      ctx.globalAlpha = 0.7;
      ctx.fillText(`${t}s`, Math.min(w - 22, Math.max(1, x + 2)), h - 1);
      ctx.globalAlpha = 1;
    }
  }, [waveform, scores, analyzedDuration, segments]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Waveform and excitement timeline"
      className="h-28 w-full cursor-crosshair rounded-xl border border-border bg-card"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
        onSeek(clamp(ratio, 0, 1) * analyzedDuration);
      }}
    />
  );
}
