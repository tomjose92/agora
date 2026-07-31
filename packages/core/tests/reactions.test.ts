import { describe, expect, it } from "vitest";
import { hasMine } from "../src/lib/reactions";

describe("hasMine", () => {
  it("prefers typed reactor identities over legacy names", () => {
    expect(hasMine({
      emoji: "👍",
      users: ["alice"],
      reactors: [{ type: "user", id: "tom", name: "Tom" }],
    }, "tom")).toBe(true);
  });

  it("falls back to users for legacy server payloads", () => {
    expect(hasMine({ emoji: "👍", users: ["tom"] }, "tom")).toBe(true);
  });

  it("does not mistake a same-named agent for the caller", () => {
    expect(hasMine({
      emoji: "👀",
      users: ["tom"],
      reactors: [{ type: "agent", id: "bot-a", name: "tom" }],
    }, "tom")).toBe(false);
  });
});
