import { useEffect, useRef } from "react";

import { formatTimecode } from "@/lib/format";

type Props = {
  src: string;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onTimeUpdate?: (time: number) => void;
};

/** Video preview with a live mono timecode readout. */
export function VideoPane({ src, videoRef, onTimeUpdate }: Props) {
  const readoutRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => {
      if (readoutRef.current) {
        readoutRef.current.textContent = formatTimecode(video.currentTime);
      }
      onTimeUpdate?.(video.currentTime);
    };
    video.addEventListener("timeupdate", update);
    video.addEventListener("seeked", update);
    return () => {
      video.removeEventListener("timeupdate", update);
      video.removeEventListener("seeked", update);
    };
  }, [videoRef, onTimeUpdate, src]);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-black/40">
      <video
        ref={videoRef}
        src={src}
        controls
        playsInline
        className="max-h-[420px] w-full bg-black"
        onError={() => {
          /* surfaced by the tool-level error state */
        }}
      />
      <div className="flex items-center justify-between border-t border-border bg-card px-3 py-1.5">
        <span className="micro-label">Playhead</span>
        <span ref={readoutRef} className="timecode text-primary">
          0:00.0
        </span>
      </div>
    </div>
  );
}
