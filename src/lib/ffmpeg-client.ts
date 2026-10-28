import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

import { sanitizeInputName } from "./format";

/**
 * Shared, lazily-loaded FFmpeg.wasm client. Everything runs in the browser —
 * media files are never uploaded anywhere. The single-threaded core is used,
 * so no SharedArrayBuffer / cross-origin isolation is required.
 *
 * Note: @ffmpeg/ffmpeg spawns a module worker, where importScripts() is
 * unavailable — so the core must be the ESM build loaded by URL (CORS is
 * enabled on both CDNs), not a blobified UMD script.
 *
 * Stability rules enforced here:
 * - Only one exec runs at a time (all tools share one single-threaded engine);
 *   everything else is queued FIFO.
 * - A watchdog resets the engine if it stops emitting output for two minutes.
 * - The user can cancel the running job, which resets the engine.
 * - Any failure resets the engine so the next attempt starts from clean state.
 */
const CORE_VERSION = "0.12.6";
const CDNS = ["https://unpkg.com", "https://cdn.jsdelivr.net/npm"];
const IDLE_TIMEOUT_MS = 120_000;

export class FFmpegCancelledError extends Error {
  constructor(message = "Processing was cancelled.") {
    super(message);
    this.name = "FFmpegCancelledError";
  }
}

let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
const writtenInputs = new Map<string, string>();

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (loading) return loading;
  loading = (async () => {
    let lastError: unknown = null;
    for (const cdn of CDNS) {
      try {
        const coreBase = `${cdn}/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
        const instance = new FFmpeg();
        await instance.load({
          coreURL: `${coreBase}/ffmpeg-core.js`,
          wasmURL: await toBlobURL(
            `${cdn}/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.wasm`,
            "application/wasm",
          ),
        });
        ffmpeg = instance;
        return instance;
      } catch (error) {
        lastError = error;
      }
    }
    loading = null;
    throw new Error(
      "The video engine failed to load. Check your internet connection and try again.",
      { cause: lastError },
    );
  })();
  return loading;
}

/** Kill the wasm worker (frees memory) and forget cached FS state. */
export function resetFFmpeg(): void {
  try {
    ffmpeg?.terminate();
  } catch {
    // already dead — nothing to do
  }
  ffmpeg = null;
  loading = null;
  writtenInputs.clear();
}

// --- One-job-at-a-time queue + busy signal --------------------------------

let queueTail: Promise<void> = Promise.resolve();
let activeJobs = 0;
const busyListeners = new Set<() => void>();

/** True while an FFmpeg job is running (or about to run). */
export function isEngineBusy(): boolean {
  return activeJobs > 0;
}

export function onEngineBusyChange(listener: () => void): () => void {
  busyListeners.add(listener);
  return () => {
    busyListeners.delete(listener);
  };
}

function notifyBusyChanged(): void {
  for (const listener of busyListeners) listener();
}

// --- Watchdog / cancellation ----------------------------------------------

// Rejector for the currently running exec, set while a job is in flight.
let interruptActive: ((error: Error) => void) | null = null;

/**
 * Stop the currently running job (if any) and reset the engine. The caller of
 * the running exec receives `reason` (a cancellation error by default).
 */
export function abortFFmpeg(reason?: Error): void {
  const interrupt = interruptActive;
  interrupt?.(reason ?? new FFmpegCancelledError());
}

async function execJob(args: string[], onProgress?: (ratio: number) => void): Promise<void> {
  activeJobs++;
  notifyBusyChanged();
  try {
    const ff = await getFFmpeg();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const stuck = new Promise<never>((_, reject) => {
      interruptActive = (error: Error) => {
        if (timedOut) return;
        timedOut = true;
        reject(error);
        try {
          ff.terminate();
        } catch {
          // already dead
        }
        resetFFmpeg();
      };
    });
    // Any engine output (progress line, log line) proves it is still alive.
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        interruptActive?.(
          new Error(
            "The video engine stopped responding and has been reset. Please try again.",
          ),
        );
      }, IDLE_TIMEOUT_MS);
    };
    const progressHandler = ({ progress }: { progress: number }) => {
      bump();
      onProgress?.(Math.max(0, Math.min(1, progress)));
    };
    const logHandler = () => bump();
    bump();
    ff.on("log", logHandler);
    if (onProgress) ff.on("progress", progressHandler);
    try {
      const execPromise = ff.exec(args);
      // If the watchdog/cancel interrupts, the instance is gone and this
      // promise may never settle (or reject late) — swallow it either way.
      execPromise.catch(() => undefined);
      const code = await Promise.race([execPromise, stuck]);
      if (code !== 0) {
        throw new Error(`The video engine stopped unexpectedly (code ${code}).`);
      }
    } catch (error) {
      // A crashed/terminated worker leaves the instance unusable — force reload.
      if (!timedOut) resetFFmpeg();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      interruptActive = null;
      ff.off("log", logHandler);
      if (onProgress) ff.off("progress", progressHandler);
    }
  } finally {
    activeJobs--;
    notifyBusyChanged();
  }
}

/** Run one exec; queued behind any other running job. */
export function runFFmpeg(
  args: string[],
  onProgress?: (ratio: number) => void,
): Promise<void> {
  const job = queueTail.then(() => execJob(args, onProgress));
  queueTail = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

// --- FS helpers ------------------------------------------------------------

/**
 * Writes `file` into the wasm FS under a stable name exactly once. The same
 * buffer is reused by later stages (analysis, rendering) without re-copying.
 */
export async function writeInputOnce(name: string, file: File | Blob): Promise<string> {
  const ff = await getFFmpeg();
  const stamp = `${file.size}:${(file as File).lastModified ?? 0}`;
  if (writtenInputs.get(name) !== stamp) {
    await ff.writeFile(name, await fetchFile(file));
    writtenInputs.set(name, stamp);
  }
  return name;
}

export async function removeInput(name: string): Promise<void> {
  if (!ffmpeg || !writtenInputs.has(name)) return;
  try {
    await ffmpeg.deleteFile(name);
  } catch {
    // file may already be gone after a reset
  }
  writtenInputs.delete(name);
}

export function hasInput(name: string): boolean {
  return writtenInputs.has(name);
}

export async function readOutput(name: string): Promise<Uint8Array> {
  const ff = await getFFmpeg();
  const data = await ff.readFile(name);
  if (typeof data === "string") throw new Error("Unexpected text output from the video engine.");
  if (!data || data.byteLength === 0) {
    throw new Error("The video engine produced an empty file. Please try again.");
  }
  return data;
}

/** Cheap MP4 sanity check: the "ftyp" box must appear near the file start. */
export function looksLikeMp4(data: Uint8Array): boolean {
  if (data.byteLength < 32) return false;
  const limit = Math.min(data.byteLength - 4, 4096);
  for (let i = 0; i < limit; i++) {
    if (data[i] === 0x66 && data[i + 1] === 0x74 && data[i + 2] === 0x79 && data[i + 3] === 0x70) {
      return true;
    }
  }
  return false;
}

export async function deleteTemp(...names: string[]): Promise<void> {
  const ff = ffmpeg;
  if (!ff) return;
  for (const name of names) {
    try {
      await ff.deleteFile(name);
    } catch {
      // already gone
    }
  }
}

export function safeInputName(file: File): string {
  return sanitizeInputName(file.name);
}
