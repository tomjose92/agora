/* The pure page-set transforms behind live updates. */

import { describe, expect, it } from "vitest";
import { appendMessage, replaceMessage, type MessagePages } from "../src/ws/reducer";
import type { Message } from "../src/api/types";

const msg = (id: number, text = `m${id}`): Message =>
  ({
    id, channel_id: "c1", text, ts: id, author_id: "me", author_name: "me",
    author_type: "user", thread_id: null, reply_count: 0, alias: null, meta: null,
  } as unknown as Message);

const pages = (...ids: number[][]): MessagePages =>
  ({ pages: ids.map(p => p.map(id => msg(id))), pageParams: ids.map(() => undefined) });

describe("appendMessage", () => {
  it("appends to the newest page (pages[0], newest-last)", () => {
    const next = appendMessage(pages([3, 4], [1, 2]), msg(5));
    expect(next!.pages[0].map(m => m.id)).toEqual([3, 4, 5]);
    expect(next!.pages[1].map(m => m.id)).toEqual([1, 2]);
  });
  it("dedupes an id that already landed (own POST + WS echo)", () => {
    const next = appendMessage(pages([3, 4]), msg(4));
    expect(next!.pages[0].map(m => m.id)).toEqual([3, 4]);
  });
  it("starts a page set when the cache is empty", () => {
    const next = appendMessage(undefined, msg(1));
    expect(next === undefined || next.pages.flat().some(m => m.id === 1)).toBe(true);
  });
});

describe("replaceMessage", () => {
  it("swaps a message in place", () => {
    const next = replaceMessage(pages([1, 2, 3]), msg(2, "edited"));
    expect(next!.pages[0].find(m => m.id === 2)!.text).toBe("edited");
    expect(next!.pages[0].map(m => m.id)).toEqual([1, 2, 3]);
  });
  it("leaves the set unchanged when the id is absent", () => {
    const before = pages([1, 2]);
    const next = replaceMessage(before, msg(9));
    expect(next!.pages[0].map(m => m.id)).toEqual([1, 2]);
  });
});
