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
  ThreadReadEvent,
  ThreadRenamedEvent,
  ThreadRow,
  WsEvent,
} from "../api/types";
import { keys } from "../api/keys";
import { mentionsMe } from "../lib/unread";
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

/** Replace a message in place (e.g. options resolved). */
export function replaceMessage(
  data: MessagePages | undefined,
  message: Message,
): MessagePages | undefined {
  if (!data) return undefined;
  let found = false;
  const pages = data.pages.map((p) =>
    p.map((m) => {
      if (m.id !== message.id) return m;
      found = true;
      return { ...m, ...message, reply_count: message.reply_count ?? m.reply_count };
    }),
  );
  return found ? { ...data, pages } : data;
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
    are never unread (the server also advances our marker on post). Channel
    counts track top-level messages only — thread replies badge their thread —
    but an @you anywhere bumps the channel's mention count. */
export function applyMessageToGroups(
  groups: Group[] | undefined,
  message: Message,
  username: string,
): Group[] | undefined {
  if (!groups) return undefined;
  const own = message.author_type === "user" && message.author_id === username;
  const isReply = message.thread_id != null;
  return groups.map((g) => ({
    ...g,
    channels: g.channels.map((c) => {
      if (c.id !== message.channel_id) return c;
      if (own) {
        return isReply ? c : { ...c, unread: 0, mentions: 0, last_read_id: message.id };
      }
      if (message.id <= (c.last_read_id ?? 0)) return c;
      const mention = mentionsMe(message.text, username);
      if (isReply && !mention) return c;
      return {
        ...c,
        unread: isReply ? (c.unread ?? 0) : (c.unread ?? 0) + 1,
        mentions: mention ? (c.mentions ?? 0) + 1 : (c.mentions ?? 0),
      };
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
        ? { ...c, unread: 0, mentions: 0, last_read_id: ev.last_read_id }
        : c,
    ),
  }));
}

/** A thread reply landed: update the inbox row (reply stats + unread).
    Returns undefined-unchanged semantics like the other transforms; if the
    thread isn't in the cache the caller refetches instead. */
export function applyReplyToThreads(
  threads: ThreadRow[] | undefined,
  message: Message,
  username: string,
): ThreadRow[] | undefined {
  if (!threads || message.thread_id == null) return threads;
  const own = message.author_type === "user" && message.author_id === username;
  const idx = threads.findIndex((t) => t.root.id === message.thread_id);
  if (idx < 0) return threads;
  const t = threads[idx];
  const updated: ThreadRow = {
    ...t,
    reply_count: t.reply_count + 1,
    last_reply_id: Math.max(t.last_reply_id, message.id),
    last_reply_ts: message.ts,
    unread: own ? t.unread : t.unread + 1,
    last_read_id: own ? Math.max(t.last_read_id, message.id) : t.last_read_id,
  };
  const out = threads.slice();
  out.splice(idx, 1);
  return [updated, ...out]; // newest activity first, like the server
}

export function applyThreadRead(
  threads: ThreadRow[] | undefined,
  ev: ThreadReadEvent,
): ThreadRow[] | undefined {
  if (!threads) return undefined;
  return threads.map((t) =>
    t.root.id === ev.thread_id && ev.last_read_id >= t.last_read_id
      ? { ...t, unread: 0, last_read_id: ev.last_read_id }
      : t,
  );
}

/** A thread was renamed: patch the alias on its inbox row's root. */
export function applyThreadRename(
  threads: ThreadRow[] | undefined,
  ev: ThreadRenamedEvent,
): ThreadRow[] | undefined {
  if (!threads) return undefined;
  return threads.map((t) =>
    t.root.id === ev.thread_id
      ? { ...t, root: { ...t.root, alias: ev.alias } }
      : t,
  );
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
      if (message.thread_id != null) {
        const threads = qc.getQueryData<ThreadRow[]>(keys.threads);
        if (threads && threads.some((t) => t.root.id === message.thread_id)) {
          qc.setQueryData<ThreadRow[]>(keys.threads, (t) =>
            applyReplyToThreads(t, message, ctx.username),
          );
        } else {
          // A reply in a thread we don't have rows for (maybe newly ours) —
          // let the server decide whether it belongs in the inbox.
          void qc.invalidateQueries({ queryKey: keys.threads });
        }
      }
      if (message.author_type === "agent") {
        // The agent replied: its typing/progress rows are stale.
        useLive.getState().agentDone(message.channel_id, message.author_id);
        ctx.onAgentMessage?.(message);
      }
      // New traffic changes what's unread; refetch if the screen is mounted.
      void qc.invalidateQueries({ queryKey: keys.unreads });
      break;
    }
    case "message_update": {
      const { message } = ev as { type: "message_update"; message: Message };
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
      break;
    }
    case "read": {
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyReadToGroups(groups, ev),
      );
      void qc.invalidateQueries({ queryKey: keys.unreads });
      break;
    }
    case "thread_read": {
      qc.setQueryData<ThreadRow[]>(keys.threads, (threads) =>
        applyThreadRead(threads, ev),
      );
      void qc.invalidateQueries({ queryKey: keys.unreads });
      break;
    }
    case "thread_renamed": {
      qc.setQueryData<ThreadRow[]>(keys.threads, (threads) =>
        applyThreadRename(threads, ev),
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
