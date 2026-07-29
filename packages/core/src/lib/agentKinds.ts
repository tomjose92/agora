import type { PairingKind } from "../api/types";

/** Resolve old pairing records that predate explicit kind metadata. */
export function inferPairingKind(
  token: { name: string; kind?: PairingKind },
): PairingKind | null {
  if (token.kind) return token.kind;

  const value = token.name.trim().toLowerCase();
  const matches = (prefix: string) =>
    value === prefix || value.startsWith(`${prefix}-`) || value.startsWith(`${prefix}_`);

  if (matches("codex")) return "codex";
  if (matches("cursor")) return "cursor";
  if (matches("claude")) return "claude";
  if (matches("openclaw")) return "claw";
  if (matches("hermes")) return "hermes";
  return null;
}
