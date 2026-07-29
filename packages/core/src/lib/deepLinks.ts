/** Stable, name-independent addresses for Agora conversations. */
export type DeepLinkTarget =
  | { kind: "group"; groupId: string }
  | { kind: "channel"; groupId: string; channelId: string }
  | {
      kind: "message";
      groupId: string;
      channelId: string;
      threadId: number | null;
      messageId: number;
    }
  | {
      kind: "thread";
      groupId: string;
      channelId: string;
      threadId: number;
    };

function idPart(value: string): string {
  return encodeURIComponent(value);
}

function positiveInt(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Build the canonical path. The caller may prepend its instance origin. */
export function deepLinkPath(target: DeepLinkTarget): string {
  const base = `/g/${idPart(target.groupId)}`;
  if (target.kind === "group") return base;
  const channel = `${base}/c/${idPart(target.channelId)}`;
  if (target.kind === "channel") return channel;
  if (target.kind === "thread") return `${channel}/t/${target.threadId}`;
  if (target.threadId != null) {
    return `${channel}/t/${target.threadId}/m/${target.messageId}`;
  }
  return `${channel}/m/${target.messageId}`;
}

/** Parse a canonical path. Query strings and fragments are ignored. */
export function parseDeepLink(value: string): DeepLinkTarget | null {
  let pathname: string;
  try {
    pathname = new URL(value, "https://agora.invalid").pathname;
  } catch {
    return null;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "g" || !parts[1]) return null;

  let groupId: string;
  try {
    groupId = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (!groupId || parts.length === 2) {
    return groupId && parts.length === 2 ? { kind: "group", groupId } : null;
  }
  if (parts[2] !== "c" || !parts[3]) return null;

  let channelId: string;
  try {
    channelId = decodeURIComponent(parts[3]);
  } catch {
    return null;
  }
  if (!channelId) return null;
  if (parts.length === 4) return { kind: "channel", groupId, channelId };

  if (parts[4] === "m" && parts.length === 6) {
    const messageId = positiveInt(parts[5]);
    return messageId == null
      ? null
      : { kind: "message", groupId, channelId, threadId: null, messageId };
  }
  if (parts[4] !== "t" || !parts[5]) return null;
  const threadId = positiveInt(parts[5]);
  if (threadId == null) return null;
  if (parts.length === 6) return { kind: "thread", groupId, channelId, threadId };
  if (parts[6] !== "m" || parts.length !== 8) return null;
  const messageId = positiveInt(parts[7]);
  return messageId == null
    ? null
    : { kind: "message", groupId, channelId, threadId, messageId };
}
