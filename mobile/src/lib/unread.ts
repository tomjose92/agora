/* Pure unread bookkeeping shared by the badge, the background poller and
   the notification-tap router. No Expo imports so tests stay plain. */

import type { Group } from "../api/types";

/** One channel's unread state, flattened out of the groups payload. */
export interface ChannelUnread {
  id: string;
  name: string;
  group: string;
  unread: number;
}

export function unreadChannels(groups: Group[]): ChannelUnread[] {
  return groups.flatMap((g) =>
    g.channels.map((c) => ({
      id: c.id,
      name: c.name,
      group: g.name,
      unread: c.unread ?? 0,
    })),
  );
}

export function totalUnread(groups: Group[]): number {
  return unreadChannels(groups).reduce((n, c) => n + c.unread, 0);
}

/** channel_id -> unread count, persisted between background polls. */
export type UnreadSnapshot = Record<string, number>;

export function snapshotOf(channels: ChannelUnread[]): UnreadSnapshot {
  return Object.fromEntries(channels.map((c) => [c.id, c.unread]));
}

/** Channels worth a banner: unread grew since the snapshot. A missing
    snapshot is a first run — baseline silently rather than replaying
    history as "new". Reads (unread dropping, here or on another device)
    never notify. */
export function channelsToNotify(
  prev: UnreadSnapshot | null,
  next: ChannelUnread[],
): ChannelUnread[] {
  if (!prev) return [];
  return next.filter((c) => c.unread > (prev[c.id] ?? 0));
}

/** Where a notification tap should land, from its data payload. */
export function notificationTarget(data: unknown): string | null {
  const d = data as { channel_id?: unknown; thread_id?: unknown } | null;
  if (!d || typeof d.channel_id !== "string" || !d.channel_id) return null;
  if (typeof d.thread_id === "number") {
    return `/thread/${d.channel_id}/${d.thread_id}`;
  }
  return `/channel/${d.channel_id}`;
}
