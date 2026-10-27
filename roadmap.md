# Snip30 — Roadmap

## M1 — Foundation
- [x] Install deps (@ffmpeg/ffmpeg, @ffmpeg/util, fflate)
- [x] Design system (styles.css tokens, dark-first studio theme, fonts in __root)
- [x] Root layout + head metadata, sonner Toaster
- [x] Shared FFmpeg client (CDN core load, singleton, progress, cleanup)
- [x] Upload dropzone (500 MB cap, video validation, local-processing notice)
- [x] Main page with Trim / Compile / Hype Intro tabs

## M2 — Trim & Compile tools
- [x] Trim: preview player, in/out points, ffmpeg accurate cut, download
- [x] Compile: multi-segment list, chronological concat, download
- [x] Download + ZIP flow (fflate)

## M3 — Hype Intro
- [x] Audio extraction (mono 16 kHz) via ffmpeg
- [x] Analysis Web Worker: 100 ms frames, RMS, YIN pitch, pitch variation, spectral centroid, excitement score, progress/cancel
- [x] Pitch↔Loudness weighting slider
- [x] Selection: Best Moment (1 segment, ≤30 s) + Montage (3–5 segments, 5–8 s each, chronological), silence-aware cut points, fallback
- [x] Editing UI: mode/duration controls, waveform+excitement timeline, clip list (remove/replace/regenerate), assembled preview
- [x] Rendering: fades (0.3 s), crossfades (montage), MP4 export into download/ZIP flow

## M4 — Reliability & verification
- [x] Error handling: silent audio, bad codecs, big files, worker/ffmpeg failures, cancellation, unmount cleanup
- [x] Unit tests for selection logic
- [x] Typecheck, lint, tests, build
- [x] Browser end-to-end check with a real test video (Playwright)
