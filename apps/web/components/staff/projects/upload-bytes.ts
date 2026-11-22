/**
 * Bytes leaving the browser.
 *
 * Two things every upload on these pages does, written once: say a size the
 * way a person reads it, and turn a chosen file into the base64 the contract's
 * bodies carry (`ProjectUploadRequest.archiveBase64`,
 * `SealedFileWriteBody.contentBase64`).
 *
 * Neither ever puts a byte on the page. The base64 is handed straight to the
 * request and dropped; nothing here keeps it.
 */

/** Bytes, the way a person reads them: "120 bytes", "2 KB", "32 MB", "4.5 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 bytes';
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

/** A blob's bytes, by whichever reader this browser has. */
function bytesOf(file: Blob): Promise<ArrayBuffer> {
  if (typeof (file as { arrayBuffer?: unknown }).arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * A file as base64, built in slices so a 32 MB archive never becomes one
 * 32-million-argument call.
 */
export async function fileToBase64(file: Blob): Promise<string> {
  const view = new Uint8Array(await bytesOf(file));
  const SLICE = 0x8000;
  let binary = '';
  for (let at = 0; at < view.length; at += SLICE) {
    binary += String.fromCharCode(...view.subarray(at, at + SLICE));
  }
  return btoa(binary);
}
