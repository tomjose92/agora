/* The three generated emoji datasets (ui/emoji.js, mobile, core) must stay
   in lockstep — all come from scripts/gen-emoji.js. This mirrors
   mobile/tests/emoji.test.ts for the core copy. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMOJI_CATEGORIES } from "../src/lib/emoji";

function loadVanilla(): unknown {
  const src = readFileSync(new URL("../../../ui/emoji.js", import.meta.url), "utf8");
  // ui/emoji.js is a plain script defining `const AGO_EMOJI = [...]`.
  return new Function(`${src}; return AGO_EMOJI;`)();
}

describe("emoji dataset sync", () => {
  it("core matches ui/emoji.js category-for-category", () => {
    const vanilla = loadVanilla() as { name: string; emoji: [string, string][] }[];
    expect(EMOJI_CATEGORIES.length).toBe(vanilla.length);
    EMOJI_CATEGORIES.forEach((cat, i) => {
      expect(cat.name).toBe(vanilla[i].name);
      expect(cat.emoji).toEqual(vanilla[i].emoji);
    });
  });
});
