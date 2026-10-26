import { zipSync } from "fflate";

export type DownloadItem = { name: string; data: Uint8Array | Blob };

function toBlob(item: DownloadItem): Blob {
  if (item.data instanceof Blob) return item.data;
  return new Blob([item.data as unknown as BlobPart], { type: "application/octet-stream" });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * One file downloads directly; several files are bundled into a ZIP
 * (stored uncompressed — MP4s are already compressed).
 */
export async function downloadFiles(items: DownloadItem[], zipName: string): Promise<void> {
  if (items.length === 0) return;
  if (items.length === 1) {
    triggerDownload(toBlob(items[0]), items[0].name);
    return;
  }
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const item of items) {
    let data: Uint8Array;
    if (item.data instanceof Blob) {
      data = new Uint8Array(await item.data.arrayBuffer());
    } else {
      data = item.data;
    }
    entries[item.name] = [data, { level: 0 }];
  }
  const zipped = zipSync(entries, { level: 0 });
  triggerDownload(new Blob([zipped as unknown as BlobPart], { type: "application/zip" }), zipName);
}
