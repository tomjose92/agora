export interface MaterializeDroppedFileOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export const DROP_HEAP_MAX_BYTES = 32 * 1024 * 1024;

export type DroppedFileErrorCode = "empty" | "timeout" | "too_large";

export class DroppedFileError extends Error {
  constructor(public readonly code: DroppedFileErrorCode, message: string) {
    super(message);
    this.name = "DroppedFileError";
  }
}

/** The webview heap remains bounded even when an operator allows huge files.
 * Older servers omit maxFileMb, in which case the fixed ceiling is used. */
export function dropMaterializationLimit(maxFileMb?: number): number {
  const serverBytes = typeof maxFileMb === "number" && maxFileMb > 0
    ? maxFileMb * 1024 * 1024
    : DROP_HEAP_MAX_BYTES;
  return Math.min(serverBytes, DROP_HEAP_MAX_BYTES);
}

/** Snapshot a short-lived browser drop into memory before its backing provider
 * disappears. Files above the memory bound are rejected rather than retained
 * as unprotected promised-file handles. */
export async function materializeDroppedFile(
  source: File,
  options: MaterializeDroppedFileOptions = {},
): Promise<File> {
  const maxBytes = options.maxBytes ?? DROP_HEAP_MAX_BYTES;
  // Do not reject size === 0 before reading: WKWebView file promises may not
  // expose their final metadata until their provider has produced the file.
  if (source.size > maxBytes) {
    throw new DroppedFileError("too_large", "Dropped file exceeds the preparation limit");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new DroppedFileError("timeout", "Dropped file read timed out")),
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
  if (!bytes.byteLength) throw new DroppedFileError("empty", "Dropped file was empty");
  if (bytes.byteLength > maxBytes) {
    throw new DroppedFileError("too_large", "Dropped file exceeds the preparation limit");
  }
  return new File([bytes], source.name || "file", {
    type: source.type,
    lastModified: source.lastModified,
  });
}
