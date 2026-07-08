/* Pure cache transforms for incoming /ws events, mirroring what the desktop
   UI's handlers do imperatively in ui/agora.js. The driver (applyWsEvent)
   feeds them into the TanStack Query cache; the transforms themselves are
   plain functions so they can be unit-tested against recorded frames. */

import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  Group,
  Message,
  MessageEvent,
  PinEvent,
  ReadEvent,
  WsEvent,
} from "../api/types";
import { keys } from "../api/keys";
import { useLive } from "../state/live";

export type MessagePages = InfiniteData<Message[], unknown>;

/** Append a message to its page set (newest page is pages[0], newest-last
    inside a page). No-op if the message is already present (e.g. our own
    POST already landed via the mutation). */
export function appendMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  if (!data) return undefined;
  if (data.pages.some((p) => p.some((m) => m.id === message.id))) return data;
  const pages = data.pages.slice();
  pages[0] = [...(pages[0] ?? []), message];
  return { ...data, pages };
}

/** A reply arrived: bump reply_count on its root in the top-level page set. */
export function bumpReplyCount(
  data: MessagePages | undefined,
  rootId: number,
): MessagePages | undefined {
  if (!data) return undefined;
  return {
    ...data,
    pages: data.pages.map((p) =>
      p.map((m) =>
        m.id === rootId ? { ...m, reply_count: (m.reply_count ?? 0) + 1 } : m,
      ),
    ),
  };
}

/** Unread bookkeeping on the groups payload for a new message. Own messages
    are never unread (the server also advances our marker on post). */
export function applyMessageToGroups(
  groups: Group[] | undefined,
  message: Message,
  username: string,
): Group[] | undefined {
  if (!groups) return undefined;
  const own = message.author_type === "user" && message.author_id === username;
  return groups.map((g) => ({
    ...g,
    channels: g.channels.map((c) => {
      if (c.id !== message.channel_id) return c;
      if (own) return { ...c, unread: 0, last_read_id: message.id };
      if (message.id <= (c.last_read_id ?? 0)) return c;
      return { ...c, unread: (c.unread ?? 0) + 1 };
    }),
  }));
}

export function applyReadToGroups(
  groups: Group[] | undefined,
  ev: ReadEvent,
): Group[] | undefined {
  if (!groups) return undefined;
  return groups.map((g) => ({
    ...g,
    channels: g.channels.map((c) =>
      c.id === ev.channel_id
        ? { ...c, unread: 0, last_read_id: ev.last_read_id }
        : c,
    ),
  }));
}

/* ------------------------------------------------------------- driver */

export interface WsContext {
  username: string;
  /** Called for agent messages so the app can raise a local notification
      while backgrounded. */
  onAgentMessage?: (message: Message) => void;
}

export function applyWsEvent(
  qc: QueryClient,
  ev: WsEvent,
  ctx: WsContext,
): void {
  switch (ev.type) {
    case "message": {
      const { message } = ev as MessageEvent;
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => appendMessage(data, message),
      );
      if (message.thread_id != null) {
        qc.setQueryData<MessagePages>(
          keys.messages(message.channel_id, null),
          (data) => bumpReplyCount(data, message.thread_id!),
        );
      }
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyMessageToGroups(groups, message, ctx.username),
      );
      if (message.author_type === "agent") {
        // The agent replied: its typing/progress rows are stale.
        useLive.getState().agentDone(message.channel_id, message.author_id);
        ctx.onAgentMessage?.(message);
      }
      break;
    }
    case "read": {
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyReadToGroups(groups, ev),
      );
      break;
    }
    case "pin": {
      const pin = ev as PinEvent;
      // Payload carries the full pin row on pin, only the id on unpin —
      // refetching keeps ordering/pin metadata authoritative.
      void qc.invalidateQueries({ queryKey: keys.pins(pin.channel_id) });
      break;
    }
    case "typing": {
      useLive.getState().onTyping(ev);
      break;
    }
    case "progress": {
      useLive.getState().onProgress(ev);
      break;
    }
  }
}
