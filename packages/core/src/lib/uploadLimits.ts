import { DROP_HEAP_MAX_BYTES } from "./dropFiles";

const SUPPORTED_VIDEO = /^video\/(mp4|webm|quicktime)(?:;|$)/i;

export function uploadMaxBytes(type: string, maxFileMb?: number, maxVideoMb?: number) {
  const video = SUPPORTED_VIDEO.test(type);
  const videoMb = maxVideoMb && maxVideoMb > 0 ? maxVideoMb : maxFileMb;
  const mb = video ? videoMb : maxFileMb;
  return typeof mb === "number" && mb > 0 ? mb * 1024 * 1024 : undefined;
}

export function droppedTooLargeMessage(type: string, maxFileMb?: number, maxVideoMb?: number) {
  const limit = uploadMaxBytes(type, maxFileMb, maxVideoMb);
  if (limit !== undefined && limit <= DROP_HEAP_MAX_BYTES) {
    const mb = SUPPORTED_VIDEO.test(type) && maxVideoMb && maxVideoMb > 0 ? maxVideoMb : maxFileMb;
    return `File too large (max ${mb} MB)`;
  }
  return "Large files must be attached with the paperclip";
}
