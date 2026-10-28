import { useSyncExternalStore } from "react";

import { isEngineBusy, onEngineBusyChange } from "@/lib/ffmpeg-client";

/**
 * True while any tool is running an FFmpeg job. The tools are all mounted at
 * once and share a single engine, so a busy engine disables the other tools'
 * render/analyze buttons instead of letting them queue silently.
 */
export function useEngineBusy(): boolean {
  return useSyncExternalStore(onEngineBusyChange, isEngineBusy, () => false);
}
