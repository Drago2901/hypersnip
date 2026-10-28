import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from "react";
import { Scissors, Layers, Zap, ShieldCheck } from "lucide-react";

import { UploadDropzone } from "@/components/upload-dropzone";
import { TrimTool } from "@/components/tools/trim-tool";
import { CompileTool } from "@/components/tools/compile-tool";
import { HypeTool } from "@/components/tools/hype-tool";
import { removeInput, safeInputName } from "@/lib/ffmpeg-client";

type ToolId = "trim" | "compile" | "hype";

const TOOLS: { id: ToolId; label: string; icon: typeof Scissors; blurb: string }[] = [
  { id: "trim", label: "Trim", icon: Scissors, blurb: "Cut one precise clip" },
  { id: "compile", label: "Compile", icon: Layers, blurb: "Stitch several clips" },
  { id: "hype", label: "Hype Intro", icon: Zap, blurb: "Auto-find the hype" },
];

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "HyperSnip — Trim, Compile & Hype Intro, right in your browser" },
      {
        name: "description",
        content:
          "Drop in a video to trim clips, stitch compilations, or auto-generate a hype intro from its audio. Everything runs locally — nothing is uploaded.",
      },
      { property: "og:title", content: "HyperSnip — browser-based video toolkit" },
      {
        property: "og:description",
        content:
          "Trim, compile and generate hype intros from any video — processed locally, nothing uploaded.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [activeTool, setActiveTool] = useState<ToolId>("hype");
  const inputNameRef = useRef<string | null>(null);

  useEffect(() => {
    if (!file) {
      setFileUrl(null);
      setDuration(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    // Probe duration with a throwaway element (metadata only).
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = url;
    const onMeta = () => {
      const d = probe.duration;
      setDuration(Number.isFinite(d) && d > 0 ? d : null);
    };
    probe.addEventListener("loadedmetadata", onMeta);
    probe.addEventListener("error", () => setDuration(null));
    return () => {
      probe.removeEventListener("loadedmetadata", onMeta);
      probe.src = "";
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const handleFile = (next: File) => {
    if (inputNameRef.current) void removeInput(inputNameRef.current);
    inputNameRef.current = safeInputName(next);
    setFile(next);
  };

  const handleClear = () => {
    if (inputNameRef.current) void removeInput(inputNameRef.current);
    inputNameRef.current = null;
    setFile(null);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="glow-primary flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Scissors className="h-4 w-4" />
            </div>
            <span className="text-lg font-bold tracking-tight text-foreground">
              Hyper<span className="text-primary">Snip</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium text-muted-foreground">
              100% local — nothing is uploaded
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-20 pt-8">
        {!file ? (
          <div className="mx-auto max-w-2xl">
            <h1 className="text-center text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
              Snip your video.
              <br />
              <span className="text-primary">Zero upload.</span>
            </h1>
            <p className="mt-4 text-center text-base text-muted-foreground">
              Trim, compile, or let HyperSnip find the most exciting moments from the audio —
              all inside your browser.
            </p>
            <div className="mt-8">
              <UploadDropzone file={null} duration={null} onFile={handleFile} onClear={handleClear} />
            </div>
            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              {TOOLS.map(({ id, label, icon: Icon, blurb }) => (
                <div key={id} className="rounded-xl border border-border bg-card p-4">
                  <Icon className="h-5 w-5 text-primary" />
                  <p className="mt-2 text-sm font-semibold text-foreground">{label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{blurb}</p>
                </div>
              ))}
            </div>
            <p className="mt-6 text-center text-xs text-muted-foreground">
              Processing happens on your device — your media never leaves this tab.
            </p>
          </div>
        ) : (
          <div>
            <UploadDropzone file={file} duration={duration} onFile={handleFile} onClear={handleClear} />

            <div
              role="tablist"
              aria-label="Tools"
              className="mt-6 flex w-full gap-1 rounded-xl border border-border bg-card p-1"
            >
              {TOOLS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={activeTool === id}
                  onClick={() => setActiveTool(id)}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    activeTool === id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>

            {fileUrl && (
              <div className="mt-6">
                {/* All tools stay mounted so in-flight work (e.g. Hype analysis) survives tab switches. */}
                <div hidden={activeTool !== "trim"}>
                  <TrimTool file={file} fileUrl={fileUrl} duration={duration} />
                </div>
                <div hidden={activeTool !== "compile"}>
                  <CompileTool file={file} fileUrl={fileUrl} duration={duration} />
                </div>
                <div hidden={activeTool !== "hype"}>
                  <HypeTool file={file} fileUrl={fileUrl} duration={duration} />
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
