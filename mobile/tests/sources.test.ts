/* Same stub as messageitem.test.ts: lucide ships untransformed ESM. */
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

import type { Message } from "@agora/core";
import { hostOf, visibleText } from "../src/components/Sources";

function msg(text: string, meta?: Message["meta"]): Message {
  return {
    id: 1,
    channel_id: "c",
    thread_id: null,
    author_type: "agent",
    author_id: "bot",
    author_name: "Bot",
    text,
    ts: 0,
    attachments: [],
    meta,
  };
}

describe("visibleText", () => {
  const text = "The answer.\n\nSources:\nhttps://a.com";
  const sources = [{ url: "https://a.com" }];

  it("cuts the trailing sources block at meta.sources_start", () => {
    expect(visibleText(msg(text, { sources, sources_start: 13 }))).toBe("The answer.");
  });

  it("slices in UTF-16 units, matching the server's offset", () => {
    // "emoji 🎉 first.\n" is 15 chars but 16 UTF-16 units — the server
    // counts the latter, and String.slice must agree.
    const emoji = "emoji 🎉 first.\nSources:\nhttps://a.com";
    expect(visibleText(msg(emoji, { sources, sources_start: 16 }))).toBe("emoji 🎉 first.");
  });

  it("leaves the text alone without sources or a sane offset", () => {
    expect(visibleText(msg(text))).toBe(text);
    expect(visibleText(msg(text, { sources }))).toBe(text);
    expect(visibleText(msg(text, { sources: [], sources_start: 13 }))).toBe(text);
    expect(visibleText(msg(text, { sources, sources_start: 0 }))).toBe(text);
    expect(visibleText(msg(text, { sources, sources_start: text.length + 5 }))).toBe(text);
    expect(visibleText(msg(text, { sources, sources_start: 13.5 }))).toBe(text);
  });
});

describe("hostOf", () => {
  it("extracts the host, dropping www and paths", () => {
    expect(hostOf("https://www.example.com/a/b?c=1")).toBe("example.com");
    expect(hostOf("http://sub.site.io")).toBe("sub.site.io");
    expect(hostOf("not a url")).toBe("");
  });
});
