import { describe, expect, it } from "vitest";
import type { Message } from "../api/types";
import { conversationSections } from "./sections";

const message = (
  id: number,
  author_type: Message["author_type"],
  text = "text",
): Message => ({
  id,
  channel_id: "general",
  thread_id: null,
  author_type,
  author_id: author_type === "user" ? "alice" : "helper",
  author_name: author_type === "user" ? "Alice" : "Helper",
  text,
  ts: 1,
  attachments: [],
});

describe("conversationSections", () => {
  it("groups agent replies under the preceding user turn", () => {
    expect(
      conversationSections([
        message(1, "user"),
        message(2, "agent"),
        message(3, "user"),
        message(4, "agent"),
      ]).map((section) => section.mid),
    ).toEqual([1, 3]);
  });

  it("makes a leading agent group a section and normalizes its label", () => {
    expect(
      conversationSections([
        message(1, "agent", "  First\n  response  "),
        message(2, "agent"),
        message(3, "user"),
      ]),
    ).toEqual([
      { mid: 1, label: "Helper: First response" },
      { mid: 3, label: "Alice: text" },
    ]);
  });
});
