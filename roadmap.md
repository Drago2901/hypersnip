# Snip30 — Roadmap

## M1 — Foundation
- [x] Install deps (@ffmpeg/ffmpeg, @ffmpeg/util, fflate)
- [ ] Design system (styles.css tokens, dark-first studio theme, fonts in __root)
- [ ] Root layout + head metadata, sonner Toaster
- [ ] Shared FFmpeg client (CDN core load, singleton, progress, cleanup)
- [ ] Upload dropzone (500 MB cap, video validation, local-processing notice)
- [ ] Main page with Trim / Compile / Hype Intro tabs

## M2 — Trim & Compile tools
- [ ] Trim: preview player, in/out points, ffmpeg accurate cut, download
- [ ] Compile: multi-segment list, chronological concat, download
- [ ] Download + ZIP flow (fflate)

## M3 — Hype Intro
- [ ] Audio extraction (mono 16 kHz) via ffmpeg
- [ ] Analysis Web Worker: 100 ms frames, RMS, YIN pitch, pitch variation, spectral centroid, excitement score, progress/cancel
- [ ] Pitch↔Loudness weighting slider
- [ ] Selection: Best Moment (1 segment, ≤30 s) + Montage (3–5 segments, 5–8 s each, chronological), silence-aware cut points, fallback
- [ ] Editing UI: mode/duration controls, waveform+excitement timeline, clip list (remove/replace/regenerate), assembled preview
- [ ] Rendering: fades (0.3 s), crossfades (montage), MP4 export into download/ZIP flow

## M4 — Reliability & verification
- [ ] Error handling: silent audio, bad codecs, big files, worker/ffmpeg failures, cancellation, unmount cleanup
- [ ] Unit tests for selection logic
- [ ] Typecheck, lint, tests, build
- [ ] Browser end-to-end check with a real test video (Playwright)
