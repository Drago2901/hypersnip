import { useCallback, useRef, useState } from "react";
import { FileVideo, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { MAX_FILE_BYTES, formatBytes, formatDuration } from "@/lib/format";
import { Button } from "@/components/ui/button";

const ACCEPTED_EXT = /\.(mp4|mov|webm|mkv|m4v|avi|ts|mpg|mpeg|3gp|flv|ogv)$/i;

type Props = {
  file: File | null;
  duration: number | null;
  onFile: (file: File) => void;
  onClear: () => void;
};

export function UploadDropzone({ file, duration, onFile, onClear }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const validate = useCallback(
    (candidate: File): boolean => {
      const okType = candidate.type.startsWith("video/") || ACCEPTED_EXT.test(candidate.name);
      if (!okType) {
        toast.error("That doesn't look like a video file. Try MP4, MOV, WebM or MKV.");
        return false;
      }
      if (candidate.size > MAX_FILE_BYTES) {
        toast.error(
          `"${candidate.name}" is ${formatBytes(candidate.size)} — the limit is 500 MB.`,
        );
        return false;
      }
      return true;
    },
    [],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const candidate = files?.[0];
      if (candidate && validate(candidate)) onFile(candidate);
    },
    [onFile, validate],
  );

  if (file) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <FileVideo className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
          <p className="timecode text-muted-foreground">
            {formatBytes(file.size)}
            {duration ? ` · ${formatDuration(duration)}` : ""}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} aria-label="Remove video">
          <X className="h-4 w-4" />
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload a video"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors ${
        dragOver
          ? "border-primary bg-primary/10"
          : "border-border bg-card/50 hover:border-primary/50 hover:bg-card"
      }`}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
        <Upload className="h-6 w-6" />
      </div>
      <div>
        <p className="text-base font-semibold text-foreground">Drop a video here</p>
        <p className="mt-1 text-sm text-muted-foreground">
          or click to browse · MP4, MOV, WebM, MKV · up to 500 MB
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
