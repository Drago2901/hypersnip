import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCcw, Scissors } from "lucide-react";
import { toast } from "sonner";

import { VideoPane } from "@/components/tools/video-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { downloadFiles, type DownloadItem } from "@/lib/download";
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
import { formatTimecode } from "@/lib/format";

type Props = { file: File; fileUrl: string; duration: number | null };

const ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-sn",
];

export function TrimTool({ file, fileUrl, duration }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ url: string; blob: Blob; name: string } | null>(null);
  const engineBusy = useEngineBusy();
  const inputName = safeInputName(file);

  // A new video starts from clean state — stale points and old results would
  // otherwise produce clips of the wrong file.
  useEffect(() => {
    setStart(0);
    setEnd(0);
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, [file]);

  const outputDuration = Math.max(0, end - start);
  const valid = outputDuration >= 0.5 && (!duration || end <= duration + 0.05);

  const setIn = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    setStart(t);
    if (t >= end) setEnd(Math.min(t + 10, duration ?? t + 10));
  }, [end, duration]);

  const setOut = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    if (t <= start + 0.5) {
      toast.error("The out point must come after the in point.");
      return;
    }
    setEnd(t);
  }, [start]);

  const exportClip = async () => {
    setBusy(true);
    setProgress(0);
    setResult(null);
    try {
      await writeInputOnce(inputName, file);
      const outName = "trim-output.mp4";
      const fadeOut = outputDuration > 0.6 ? outputDuration - 0.3 : 0;
      const vf =
        outputDuration > 0.6
          ? `fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.3`
          : "fade=t=in:st=0:d=0.3";
      const af =
        outputDuration > 0.6
          ? `afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeOut.toFixed(2)}:d=0.3`
          : "afade=t=in:st=0:d=0.3";
      await runFFmpeg(
        [
          "-ss", start.toFixed(3),
          "-i", inputName,
          "-t", outputDuration.toFixed(3),
          "-vf", vf,
          "-af", af,
          ...ENCODE,
          "-y", outName,
        ],
        setProgress,
      );
      const data = await readOutput(outName);
      if (!looksLikeMp4(data)) {
        throw new Error(
          "The export came out damaged. Please try again — if it keeps happening, try a different file.",
        );
      }
      const blob = new Blob([data as unknown as BlobPart], { type: "video/mp4" });
      const base = file.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").slice(0, 60) || "clip";
      const name = `${base}-trim.mp4`;
      setResult({ url: URL.createObjectURL(blob), blob, name });
      await deleteTemp(outName);
      toast.success("Clip ready — download it below.");
    } catch (error) {
      if (error instanceof FFmpegCancelledError) {
        toast.message("Cancelled.");
      } else {
        console.error(error);
        toast.error(
          error instanceof Error ? error.message : "Something went wrong while cutting the clip.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const clearResult = () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <VideoPane src={fileUrl} videoRef={videoRef} />

      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="micro-label">Trim points</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={setIn} disabled={busy}>
              Set in <span className="timecode ml-1">{formatTimecode(start)}</span>
            </Button>
            <Button variant="secondary" onClick={setOut} disabled={busy}>
              Set out <span className="timecode ml-1">{formatTimecode(end)}</span>
            </Button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="micro-label">In (s)</span>
              <Input
                type="number"
                step="0.1"
                min={0}
                value={start.toFixed(1)}
                disabled={busy}
                onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
                className="timecode"
              />
            </label>
            <label className="space-y-1">
              <span className="micro-label">Out (s)</span>
              <Input
                type="number"
                step="0.1"
                min={0}
                value={end.toFixed(1)}
                disabled={busy}
                onChange={(e) => setEnd(Math.max(0, Number(e.target.value) || 0))}
                className="timecode"
              />
            </label>
          </div>
          <p className="timecode mt-3 text-muted-foreground">
            Output: {formatTimecode(outputDuration)}
          </p>
          {!valid && outputDuration > 0 && (
            <p className="mt-1 text-xs text-destructive">
              Set an out point at least 0.5 s after the in point.
            </p>
          )}
        </div>

        {busy && (
          <div className="space-y-2 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Cutting clip… {Math.round(progress * 100)}%
            </div>
            <Progress value={progress * 100} />
            <Button variant="secondary" className="w-full" onClick={() => abortFFmpeg()}>
              Cancel
            </Button>
          </div>
        )}

        {result ? (
          <div className="space-y-3 rounded-xl border border-primary/40 bg-card p-4">
            <p className="micro-label text-primary">Your clip is ready</p>
            <video src={result.url} controls className="w-full rounded-lg bg-black" />
            <div className="flex gap-2">
              <Button
                className="flex-1"
                onClick={() =>
                  downloadFiles([{ name: result.name, data: result.blob }], "hypersnip.zip")
                }
              >
                <Download className="h-4 w-4" /> Download MP4
              </Button>
              <Button variant="secondary" onClick={clearResult}>
                <RefreshCcw className="h-4 w-4" /> Again
              </Button>
            </div>
          </div>
        ) : (
          <>
            {engineBusy && (
              <p className="text-center text-xs text-muted-foreground">
                The video engine is busy with another tool — try again in a moment.
              </p>
            )}
            <Button className="w-full" size="lg" onClick={exportClip} disabled={busy || !valid || engineBusy}>
              <Scissors className="h-4 w-4" />
              {busy ? "Cutting…" : "Cut clip"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
