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
 */
const CORE_VERSION = "0.12.6";
const CDNS = ["https://unpkg.com", "https://cdn.jsdelivr.net/npm"];

let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
const writtenInputs = new Map<string, number>();

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

/**
 * Writes `file` into the wasm FS under a stable name exactly once. The same
 * buffer is reused by later stages (analysis, rendering) without re-copying.
 */
export async function writeInputOnce(name: string, file: File | Blob): Promise<string> {
  const ff = await getFFmpeg();
  if (writtenInputs.get(name) !== file.size) {
    await ff.writeFile(name, await fetchFile(file));
    writtenInputs.set(name, file.size);
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

export async function runFFmpeg(
  args: string[],
  onProgress?: (ratio: number) => void,
): Promise<void> {
  const ff = await getFFmpeg();
  const handler = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)));
  };
  if (onProgress) ff.on("progress", handler);
  try {
    const code = await ff.exec(args);
    if (code !== 0) {
      throw new Error(`The video engine stopped unexpectedly (code ${code}).`);
    }
  } catch (error) {
    // A crashed/terminated worker leaves the instance unusable — force reload.
    resetFFmpeg();
    throw error;
  } finally {
    if (onProgress) ff.off("progress", handler);
  }
}

export async function readOutput(name: string): Promise<Uint8Array> {
  const ff = await getFFmpeg();
  const data = await ff.readFile(name);
  if (typeof data === "string") throw new Error("Unexpected text output from the video engine.");
  return data;
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
