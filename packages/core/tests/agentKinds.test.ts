import { describe, expect, it } from "vitest";
import { inferPairingKind } from "../src/lib/agentKinds";

describe("inferPairingKind", () => {
  it("prefers explicit metadata", () => {
    expect(inferPairingKind({ name: "anything", kind: "cursor" })).toBe("cursor");
  });

  it("rejects unknown explicit metadata", () => {
    expect(inferPairingKind({ name: "anything", kind: "future-agent" })).toBeNull();
  });

  it.each([
    ["Codex", "codex"],
    ["codex-macbook", "codex"],
    ["cursor_work", "cursor"],
    ["Claude-home", "claude"],
    ["OpenClaw_server", "claw"],
    ["hermes", "hermes"],
  ] as const)("infers legacy name %s", (name, expected) => {
    expect(inferPairingKind({ name })).toBe(expected);
  });

  it("does not infer from incidental substrings", () => {
    expect(inferPairingKind({ name: "my-codex" })).toBeNull();
    expect(inferPairingKind({ name: "custom integration" })).toBeNull();
  });
});
