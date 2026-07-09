import {
  channelsToNotify,
  notificationTarget,
  snapshotOf,
  totalUnread,
  unreadChannels,
} from "../src/lib/unread";
import type { Group } from "../src/api/types";

function groups(): Group[] {
  return [
    {
      id: "g1",
      name: "Home",
      description: "",
      created_by: null,
      created_at: 0,
      role: "admin",
      channels: [
        { id: "c1", group_id: "g1", name: "general", topic: "", created_at: 0, unread: 2 },
        { id: "c2", group_id: "g1", name: "random", topic: "", created_at: 0, unread: 0 },
      ],
    },
    {
      id: "g2",
      name: "Work",
      description: "",
      created_by: null,
      created_at: 0,
      role: "admin",
      channels: [
        // The groups endpoint always embeds unread, but the type is optional.
        { id: "c3", group_id: "g2", name: "standup", topic: "", created_at: 0 },
      ],
    },
  ];
}

describe("unreadChannels / totalUnread", () => {
  it("flattens groups with group names attached", () => {
    const channels = unreadChannels(groups());
    expect(channels).toEqual([
      { id: "c1", name: "general", group: "Home", unread: 2 },
      { id: "c2", name: "random", group: "Home", unread: 0 },
      { id: "c3", name: "standup", group: "Work", unread: 0 },
    ]);
    expect(totalUnread(groups())).toBe(2);
  });
});

describe("channelsToNotify", () => {
  const channels = unreadChannels(groups());

  it("baselines silently on first run (no snapshot)", () => {
    expect(channelsToNotify(null, channels)).toEqual([]);
  });

  it("notifies only channels whose unread grew", () => {
    const prev = snapshotOf(channels); // c1: 2
    const next = channels.map((c) => (c.id === "c1" ? { ...c, unread: 5 } : c));
    expect(channelsToNotify(prev, next).map((c) => c.id)).toEqual(["c1"]);
  });

  it("treats channels missing from the snapshot as previously zero", () => {
    const next = channels.map((c) => (c.id === "c3" ? { ...c, unread: 1 } : c));
    expect(channelsToNotify({}, next).map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("never notifies when unread dropped (read elsewhere)", () => {
    const prev = snapshotOf(channels);
    const next = channels.map((c) => ({ ...c, unread: 0 }));
    expect(channelsToNotify(prev, next)).toEqual([]);
  });
});

describe("notificationTarget", () => {
  it("routes to the channel", () => {
    expect(notificationTarget({ channel_id: "c1", thread_id: null })).toBe("/channel/c1");
  });

  it("routes to the thread when present", () => {
    expect(notificationTarget({ channel_id: "c1", thread_id: 42 })).toBe("/thread/c1/42");
  });

  it("rejects payloads without a channel", () => {
    expect(notificationTarget(null)).toBeNull();
    expect(notificationTarget({})).toBeNull();
    expect(notificationTarget({ channel_id: 7 })).toBeNull();
  });
});
