<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- FFmpeg.wasm must load the ESM core (`@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js`) by CDN URL with a blobified wasm — never blobify the UMD core script. The @ffmpeg/ffmpeg class spawns a module-type worker, where `importScripts()` throws, so the UMD blob fails with "failed to import ffmpeg-core.js".
