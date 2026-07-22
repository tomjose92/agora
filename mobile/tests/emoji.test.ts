import * as fs from "fs";
import * as path from "path";
import { EMOJI_CATEGORIES } from "@agora/core";

describe("emoji dataset", () => {
  it("has non-empty categories with lowercase keywords", () => {
    expect(EMOJI_CATEGORIES.length).toBeGreaterThan(0);
    for (const cat of EMOJI_CATEGORIES) {
      expect(cat.emoji.length).toBeGreaterThan(0);
      for (const [ch, keywords] of cat.emoji) {
        expect(ch.length).toBeGreaterThan(0);
        expect(keywords).toBe(keywords.toLowerCase());
        expect(keywords.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate emoji across categories", () => {
    const seen = new Set<string>();
    for (const cat of EMOJI_CATEGORIES) {
      for (const [ch] of cat.emoji) {
        expect(seen.has(ch)).toBe(false);
        seen.add(ch);
      }
    }
  });

  it("matches the web UI dataset (ui/emoji.js)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../ui/emoji.js"), "utf8");
    // ui/emoji.js is a plain script that declares AGO_EMOJI; evaluate it and
    // compare — the two clients must ship identical emoji data.
    const web = new Function(`${src}; return AGO_EMOJI;`)();
    expect(web).toEqual(EMOJI_CATEGORIES.map((c) => ({ name: c.name, emoji: c.emoji })));
  });
});
