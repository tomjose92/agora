import { hasMine, legacyReactors, reactorNames } from "../src/lib/reactions";

describe("mobile reaction compatibility helpers", () => {
  it("uses typed identities for ownership and names", () => {
    const reaction = {
      emoji: "👀",
      users: ["tom"],
      reactors: [{ type: "agent" as const, id: "bot-a", name: "Tom Agent" }],
    };
    expect(hasMine(reaction, "tom")).toBe(false);
    expect(reactorNames(reaction)).toEqual(["Tom Agent"]);
    expect(legacyReactors(reaction)).toEqual(reaction.reactors);
  });

  it("falls back to legacy users when reactors are absent", () => {
    const reaction = { emoji: "👍", users: ["tom", "alice"] };
    expect(hasMine(reaction, "tom")).toBe(true);
    expect(reactorNames(reaction)).toEqual(["tom", "alice"]);
    expect(legacyReactors(reaction)).toEqual([
      { type: "user", id: "tom", name: "tom" },
      { type: "user", id: "alice", name: "alice" },
    ]);
  });
});
