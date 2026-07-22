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

});
