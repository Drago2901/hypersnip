import { useCallback, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Download, Layers, Loader2, Plus, RefreshCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { VideoPane } from "@/components/tools/video-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { downloadFiles } from "@/lib/download";
import {
  deleteTemp,
  readOutput,
  runFFmpeg,
  safeInputName,
  writeInputOnce,
} from "@/lib/ffmpeg-client";
import { formatDuration, formatTimecode } from "@/lib/format";

type Props = { file: File; fileUrl: string; duration: number | null };

type Seg = { id: number; start: number; dur: number };

const ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-sn",
];

let nextId = 1;

export function CompileTool({ file, fileUrl, duration }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [segments, setSegments] = useState<Seg[]>([]);
  const [clipLength, setClipLength] = useState(10);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [result, setResult] = useState<{ url: string; blob: Blob; name: string } | null>(null);
  const inputName = safeInputName(file);

  const totalTime = segments.reduce((sum, s) => sum + s.dur, 0);

  const playhead = () => videoRef.current?.currentTime ?? 0;

  const addSegment = useCallback(() => {
    const start = playhead();
    const dur = Math.min(Math.max(clipLength, 0.5), Math.max(0.5, (duration ?? Infinity) - start));
    if (duration && start >= duration - 0.2) {
      toast.error("The playhead is already at the end of the video.");
      return;
    }
    setSegments((prev) => [...prev, { id: nextId++, start, dur }]);
  }, [clipLength, duration]);

  const updateSeg = (id: number, patch: Partial<Seg>) =>
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const move = (index: number, dir: -1 | 1) =>
    setSegments((prev) => {
      const next = [...prev];
      const target = index + dir;
      const a = next[index];
      const b = next[target];
      if (target < 0 || target >= next.length || !a || !b) return prev;
      next[index] = b;
      next[target] = a;
      return next;
    });

  const compile = async () => {
    if (segments.length === 0) return;
    setBusy(true);
    setProgress(0);
    setResult(null);
    const tempNames: string[] = [];
    try {
      await writeInputOnce(inputName, file);
      const listLines: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) continue;
        setStage(`Cutting clip ${i + 1} of ${segments.length}…`);
        const segName = `seg-${i}.mp4`;
        tempNames.push(segName);
        await runFFmpeg(
          [
            "-ss", seg.start.toFixed(3),
            "-i", inputName,
            "-t", seg.dur.toFixed(3),
            ...ENCODE,
            "-y", segName,
          ],
          (p) => setProgress((i + p) / (segments.length + 1)),
        );
        listLines.push(`file '${segName}'`);
      }
      setStage("Joining clips…");
      await writeInputOnce("concat-list.txt", new Blob([listLines.join("\n")]));
      const outName = "compile-output.mp4";
      tempNames.push(outName);
      await runFFmpeg(["-f", "concat", "-safe", "0", "-i", "concat-list.txt", "-c", "copy", "-y", outName]);
      const data = await readOutput(outName);
      const blob = new Blob([data as unknown as BlobPart], { type: "video/mp4" });
      const base = file.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").slice(0, 60) || "video";
      setResult({ url: URL.createObjectURL(blob), blob, name: `${base}-compile.mp4` });
      toast.success("Compilation ready — download it below.");
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error ? error.message : "Something went wrong while compiling.",
      );
    } finally {
      setBusy(false);
      setStage("");
      await deleteTemp(...tempNames, "concat-list.txt");
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
          <p className="micro-label">Clips, in order</p>
          <div className="mt-3 flex gap-2">
            <label className="w-24 space-y-1">
              <span className="micro-label">Length (s)</span>
              <Input
                type="number"
                step="0.5"
                min={0.5}
                value={clipLength}
                disabled={busy}
                onChange={(e) => setClipLength(Math.max(0.5, Number(e.target.value) || 0.5))}
                className="timecode"
              />
            </label>
            <Button className="mt-auto flex-1" variant="secondary" onClick={addSegment} disabled={busy}>
              <Plus className="h-4 w-4" /> Add from playhead
            </Button>
          </div>

          <div className="mt-3 space-y-1.5">
            {segments.length === 0 && (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                No clips yet — pause the video and add one.
              </p>
            )}
            {segments.map((seg, i) => (
              <div key={seg.id} className="flex items-center gap-1.5 rounded-lg border border-border bg-background/40 px-2 py-1.5">
                <span className="w-4 text-center text-xs font-semibold text-muted-foreground">{i + 1}</span>
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  aria-label={`Clip ${i + 1} start`}
                  value={seg.start.toFixed(1)}
                  disabled={busy}
                  onChange={(e) => updateSeg(seg.id, { start: Math.max(0, Number(e.target.value) || 0) })}
                  className="timecode h-7 flex-1 px-1.5"
                />
                <span className="text-xs text-muted-foreground">+</span>
                <Input
                  type="number"
                  step="0.1"
                  min={0.5}
                  aria-label={`Clip ${i + 1} length`}
                  value={seg.dur.toFixed(1)}
                  disabled={busy}
                  onChange={(e) => updateSeg(seg.id, { dur: Math.max(0.5, Number(e.target.value) || 0.5) })}
                  className="timecode h-7 w-16 px-1.5"
                />
                <div className="flex flex-col">
                  <button aria-label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30">
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button aria-label="Move down" disabled={busy || i === segments.length - 1} onClick={() => move(i, 1)}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30">
                    <ArrowDown className="h-3 w-3" />
                  </button>
                </div>
                <button aria-label={`Remove clip ${i + 1}`} disabled={busy} onClick={() => setSegments((p) => p.filter((s) => s.id !== seg.id))}
                  className="rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-30">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <p className="timecode mt-3 text-muted-foreground">
            Total: {formatDuration(totalTime)}
          </p>
        </div>

        {busy && (
          <div className="space-y-2 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {stage} {Math.round(progress * 100)}%
            </div>
            <Progress value={progress * 100} />
          </div>
        )}

        {result ? (
          <div className="space-y-3 rounded-xl border border-primary/40 bg-card p-4">
            <p className="micro-label text-primary">Your compilation is ready</p>
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
        ) : (
          <Button className="w-full" size="lg" onClick={compile} disabled={busy || segments.length === 0}>
            <Layers className="h-4 w-4" />
            {busy ? "Compiling…" : `Compile ${segments.length || ""} clip${segments.length === 1 ? "" : "s"}`}
          </Button>
        )}
      </div>
    </div>
  );
}

void formatTimecode;
