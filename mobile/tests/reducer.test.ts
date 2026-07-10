/* WS reducer tests. Frame shapes are copied from the Rust hub's own tests
   (crates/agora-core/src/hub.rs) and from store.rs payloads. */

import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import type {
  Group,
  Message,
  ProgressEvent,
  ThreadRow,
  TypingEvent,
} from "../src/api/types";
import { useLive } from "../src/state/live";
import {
  appendMessage,
  applyMessageToGroups,
  applyReadToGroups,
  applyReplyToThreads,
  applyThreadRead,
  applyWsEvent,
  bumpReplyCount,
  replaceMessage,
  type MessagePages,
} from "../src/ws/reducer";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 10,
    channel_id: "general-1a2b",
    thread_id: null,
    author_type: "agent",
    author_id: "bot-a",
    author_name: "Bot A",
    text: "done!",
    ts: 1751900000,
    attachments: [],
    ...over,
  };
}

function pages(...msgs: Message[][]): MessagePages {
  return { pages: msgs, pageParams: msgs.map(() => undefined) };
}

function groups(): Group[] {
  return [
    {
      id: "g1",
      name: "Home",
      description: "",
      created_by: "me",
      created_at: 0,
      role: "admin",
      channels: [
        {
          id: "general-1a2b",
          group_id: "g1",
          name: "general",
          topic: "",
          created_at: 0,
          unread: 0,
          last_read_id: 9,
        },
      ],
    },
  ];
}

describe("appendMessage", () => {
  it("appends to the newest page", () => {
    const data = pages([msg({ id: 9 })]);
    const out = appendMessage(data, msg({ id: 10 }))!;
    expect(out.pages[0].map((m) => m.id)).toEqual([9, 10]);
  });

  it("dedupes a message that already landed (own POST + WS echo)", () => {
    const data = pages([msg({ id: 10 })]);
    expect(appendMessage(data, msg({ id: 10 }))).toBe(data);
  });

  it("leaves an unfetched channel alone", () => {
    expect(appendMessage(undefined, msg())).toBeUndefined();
  });
});

describe("bumpReplyCount", () => {
  it("increments the root's reply_count", () => {
    const data = pages([msg({ id: 5, reply_count: 1 })]);
    const out = bumpReplyCount(data, 5)!;
    expect(out.pages[0][0].reply_count).toBe(2);
  });
});

describe("applyMessageToGroups", () => {
  it("increments unread for someone else's message", () => {
    const out = applyMessageToGroups(groups(), msg({ id: 10 }), "me")!;
    expect(out[0].channels[0].unread).toBe(1);
  });

  it("clears unread for my own message (server advances my marker)", () => {
    const g = groups();
    g[0].channels[0].unread = 3;
    const mine = msg({ id: 10, author_type: "user", author_id: "me" });
    const out = applyMessageToGroups(g, mine, "me")!;
    expect(out[0].channels[0].unread).toBe(0);
    expect(out[0].channels[0].last_read_id).toBe(10);
  });

  it("ignores messages at or below the read marker", () => {
    const out = applyMessageToGroups(groups(), msg({ id: 9 }), "me")!;
    expect(out[0].channels[0].unread).toBe(0);
  });

  it("thread replies don't move the channel count", () => {
    const out = applyMessageToGroups(groups(), msg({ id: 10, thread_id: 5 }), "me")!;
    expect(out[0].channels[0].unread).toBe(0);
  });

  it("an @me bumps the mention count — even from inside a thread", () => {
    const out = applyMessageToGroups(
      groups(),
      msg({ id: 10, thread_id: 5, text: "ping @me here" }),
      "me",
    )!;
    expect(out[0].channels[0].unread).toBe(0);
    expect(out[0].channels[0].mentions).toBe(1);
  });

  it("a top-level @me bumps both counts", () => {
    const out = applyMessageToGroups(groups(), msg({ id: 10, text: "hey @me" }), "me")!;
    expect(out[0].channels[0]).toMatchObject({ unread: 1, mentions: 1 });
  });
});

function threadRow(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    root: msg({ id: 5, author_type: "user", author_id: "me" }),
    channel_id: "general-1a2b",
    channel_name: "general",
    group_id: "g1",
    group_name: "Home",
    reply_count: 1,
    last_reply_id: 8,
    last_reply_ts: 1751899000,
    last_read_id: 8,
    unread: 0,
    ...over,
  };
}

describe("applyReplyToThreads", () => {
  it("bumps reply stats and unread for someone else's reply", () => {
    const out = applyReplyToThreads([threadRow()], msg({ id: 11, thread_id: 5 }), "me")!;
    expect(out[0]).toMatchObject({
      reply_count: 2,
      last_reply_id: 11,
      unread: 1,
    });
  });

  it("my own reply advances my marker without unread", () => {
    const mine = msg({ id: 11, thread_id: 5, author_type: "user", author_id: "me" });
    const out = applyReplyToThreads([threadRow()], mine, "me")!;
    expect(out[0]).toMatchObject({ reply_count: 2, unread: 0, last_read_id: 11 });
  });

  it("moves the thread to the top (newest activity first)", () => {
    const other = threadRow({ root: msg({ id: 99 }), last_reply_id: 100 });
    const out = applyReplyToThreads(
      [other, threadRow()],
      msg({ id: 101, thread_id: 5 }),
      "me",
    )!;
    expect(out.map((t) => t.root.id)).toEqual([5, 99]);
  });

  it("leaves unknown threads alone (caller refetches)", () => {
    const rows = [threadRow()];
    expect(applyReplyToThreads(rows, msg({ id: 11, thread_id: 42 }), "me")).toBe(rows);
  });
});

describe("applyThreadRead", () => {
  it("zeroes unread and moves the marker", () => {
    const out = applyThreadRead([threadRow({ unread: 3 })], {
      type: "thread_read",
      thread_id: 5,
      channel_id: "general-1a2b",
      last_read_id: 20,
    })!;
    expect(out[0]).toMatchObject({ unread: 0, last_read_id: 20 });
  });

  it("ignores stale acks", () => {
    const out = applyThreadRead([threadRow({ unread: 2, last_read_id: 30 })], {
      type: "thread_read",
      thread_id: 5,
      channel_id: "general-1a2b",
      last_read_id: 20,
    })!;
    expect(out[0]).toMatchObject({ unread: 2, last_read_id: 30 });
  });
});

describe("applyReadToGroups", () => {
  it("zeroes unread and moves the marker", () => {
    const g = groups();
    g[0].channels[0].unread = 4;
    const out = applyReadToGroups(g, {
      type: "read",
      channel_id: "general-1a2b",
      last_read_id: 14,
    })!;
    expect(out[0].channels[0]).toMatchObject({ unread: 0, last_read_id: 14 });
  });
});

describe("applyWsEvent", () => {
  let qc: QueryClient;
  beforeEach(() => {
    qc = new QueryClient();
    useLive.setState({ typing: {}, progress: {} });
  });
  afterEach(() => {
    qc.clear(); // drop gc timers so jest workers exit cleanly
  });

  it("routes a message frame into the channel page set and groups", () => {
    qc.setQueryData(keys.messages("general-1a2b", null), pages([msg({ id: 9 })]));
    qc.setQueryData(keys.groups, groups());
    const seen: Message[] = [];
    applyWsEvent(
      qc,
      { type: "message", message: msg({ id: 10 }) },
      { username: "me", onAgentMessage: (m) => seen.push(m) },
    );
    const data = qc.getQueryData<MessagePages>(keys.messages("general-1a2b", null))!;
    expect(data.pages[0].map((m) => m.id)).toEqual([9, 10]);
    const g = qc.getQueryData<Group[]>(keys.groups)!;
    expect(g[0].channels[0].unread).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("routes a thread reply into the thread pages and bumps the root", () => {
    qc.setQueryData(keys.messages("general-1a2b", null), pages([msg({ id: 5, reply_count: 0 })]));
    qc.setQueryData(keys.messages("general-1a2b", 5), pages([]));
    applyWsEvent(
      qc,
      { type: "message", message: msg({ id: 11, thread_id: 5 }) },
      { username: "me" },
    );
    const thread = qc.getQueryData<MessagePages>(keys.messages("general-1a2b", 5))!;
    expect(thread.pages[0].map((m) => m.id)).toEqual([11]);
    const top = qc.getQueryData<MessagePages>(keys.messages("general-1a2b", null))!;
    expect(top.pages[0][0].reply_count).toBe(1);
  });

  it("tracks typing on and off, clearing that agent's progress too", () => {
    // Frame shape from hub.rs tests.
    const typing: TypingEvent = {
      type: "typing",
      channel_id: "general-1a2b",
      thread_id: null,
      agent_id: "bot-a",
      agent_name: "Bot A",
      active: true,
    };
    const progress: ProgressEvent = {
      type: "progress",
      channel_id: "general-1a2b",
      thread_id: null,
      agent_id: "bot-a",
      agent_name: "Bot A",
      handle: "h1",
      text: "reading files…",
    };
    applyWsEvent(qc, typing, { username: "me" });
    applyWsEvent(qc, progress, { username: "me" });
    expect(Object.keys(useLive.getState().typing["general-1a2b"])).toEqual(["bot-a"]);
    expect(Object.keys(useLive.getState().progress["general-1a2b"])).toEqual(["h1"]);

    applyWsEvent(qc, { ...typing, active: false }, { username: "me" });
    expect(useLive.getState().typing["general-1a2b"]).toEqual({});
    expect(useLive.getState().progress["general-1a2b"]).toEqual({});
  });

  it("an agent's reply clears its own typing/progress", () => {
    useLive.getState().onTyping({
      type: "typing",
      channel_id: "general-1a2b",
      thread_id: null,
      agent_id: "bot-a",
      agent_name: "Bot A",
      active: true,
    });
    applyWsEvent(qc, { type: "message", message: msg({ id: 12 }) }, { username: "me" });
    expect(useLive.getState().typing["general-1a2b"]).toEqual({});
  });

  it("applies read frames to the groups cache", () => {
    qc.setQueryData(keys.groups, groups());
    applyWsEvent(
      qc,
      { type: "read", channel_id: "general-1a2b", last_read_id: 20 },
      { username: "me" },
    );
    expect(qc.getQueryData<Group[]>(keys.groups)![0].channels[0].last_read_id).toBe(20);
  });

  it("routes a thread reply into the threads inbox cache", () => {
    qc.setQueryData(keys.threads, [threadRow()]);
    applyWsEvent(
      qc,
      { type: "message", message: msg({ id: 11, thread_id: 5 }) },
      { username: "me" },
    );
    const threads = qc.getQueryData<ThreadRow[]>(keys.threads)!;
    expect(threads[0]).toMatchObject({ reply_count: 2, unread: 1 });
  });

  it("applies thread_read frames to the threads cache", () => {
    qc.setQueryData(keys.threads, [threadRow({ unread: 2 })]);
    applyWsEvent(
      qc,
      { type: "thread_read", thread_id: 5, channel_id: "general-1a2b", last_read_id: 20 },
      { username: "me" },
    );
    expect(qc.getQueryData<ThreadRow[]>(keys.threads)![0]).toMatchObject({
      unread: 0,
      last_read_id: 20,
    });
  });

  it("applies message_update frames (options resolved)", () => {
    const original = msg({
      id: 42,
      meta: {
        options: [
          { id: "approve", label: "Approve" },
          { id: "reject", label: "Reject" },
        ],
        options_id: "abc",
        resolved: null,
      },
    });
    qc.setQueryData(keys.messages("general-1a2b", null), pages([original]));
    applyWsEvent(
      qc,
      {
        type: "message_update",
        message: {
          ...original,
          meta: {
            ...original.meta!,
            resolved: { option_id: "approve", by: "me", ts: 1 },
          },
        },
      },
      { username: "me" },
    );
    const data = qc.getQueryData<MessagePages>(keys.messages("general-1a2b", null))!;
    expect(data.pages[0][0].meta?.resolved?.option_id).toBe("approve");
  });
});

describe("replaceMessage", () => {
  it("merges fields onto an existing message", () => {
    const data = pages([msg({ id: 1, text: "old" })]);
    const next = replaceMessage(data, msg({ id: 1, text: "new", meta: { options: [] } }))!;
    expect(next.pages[0][0].text).toBe("new");
    expect(next.pages[0][0].meta).toEqual({ options: [] });
  });
});
