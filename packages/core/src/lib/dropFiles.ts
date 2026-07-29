export interface MaterializeDroppedFileOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Snapshot a short-lived browser drop into memory before its backing provider
 * disappears. Very large drops retain their original handle to avoid copying
 * unbounded data into the webview heap; this memory-safety ceiling means a
 * promised file above the threshold cannot receive the same protection. */
export async function materializeDroppedFile(
  source: File,
  options: MaterializeDroppedFileOptions = {},
): Promise<File> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (source.size > maxBytes) return source;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Dropped file read timed out")),
      timeoutMs,
    );
  });
  let bytes: ArrayBuffer;
  try {
    // This bounds our wait; the Blob API provides no way to cancel the read.
    bytes = await Promise.race([source.arrayBuffer(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!bytes.byteLength) throw new Error("Dropped file was empty");
  return new File([bytes], source.name || "file", {
    type: source.type,
    lastModified: source.lastModified,
  });
}
