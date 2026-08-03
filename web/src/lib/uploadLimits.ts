import { DROP_HEAP_MAX_BYTES } from "@agora/core";

export function uploadMaxBytes(type: string, maxFileMb?: number, maxVideoMb?: number) {
  const mb = type.startsWith("video/") ? (maxVideoMb ?? maxFileMb) : maxFileMb;
  return typeof mb === "number" && mb > 0 ? mb * 1024 * 1024 : undefined;
}

export function droppedTooLargeMessage(type: string, maxFileMb?: number, maxVideoMb?: number) {
  const limit = uploadMaxBytes(type, maxFileMb, maxVideoMb);
  if (limit !== undefined && limit <= DROP_HEAP_MAX_BYTES) {
    const mb = type.startsWith("video/") ? (maxVideoMb ?? maxFileMb) : maxFileMb;
    return `File too large (max ${mb} MB)`;
  }
  return "Large files must be attached with the paperclip";
}
