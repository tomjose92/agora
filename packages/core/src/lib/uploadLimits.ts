import { DROP_HEAP_MAX_BYTES } from "./dropFiles";

export function uploadMaxBytes(type: string, maxFileMb?: number, maxVideoMb?: number) {
  const video = /^video\/(mp4|webm|quicktime)(?:;|$)/i.test(type);
  const mb = video ? (maxVideoMb ?? maxFileMb) : maxFileMb;
  return typeof mb === "number" && mb > 0 ? mb * 1024 * 1024 : undefined;
}

export function droppedTooLargeMessage(type: string, maxFileMb?: number, maxVideoMb?: number) {
  const limit = uploadMaxBytes(type, maxFileMb, maxVideoMb);
  if (limit !== undefined && limit <= DROP_HEAP_MAX_BYTES) {
    const mb = /^video\/(mp4|webm|quicktime)(?:;|$)/i.test(type) ? (maxVideoMb ?? maxFileMb) : maxFileMb;
    return `File too large (max ${mb} MB)`;
  }
  return "Large files must be attached with the paperclip";
}
