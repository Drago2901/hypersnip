export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 83.421 -> "1:23.4" (or "1:02:03.4" past an hour). */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = s.toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Compact variant without tenths, for durations. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const MAX_FILE_BYTES = 500 * 1024 * 1024;

export function sanitizeInputName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > -1 ? fileName.slice(dot).toLowerCase() : ".mp4";
  const safeExt = /^(\.mp4|\.mov|\.webm|\.mkv|\.m4v|\.avi|\.ts|\.mpg|\.mpeg|\.3gp|\.flv|\.ogv)$/.test(ext)
    ? ext
    : ".mp4";
  return `input${safeExt}`;
}
