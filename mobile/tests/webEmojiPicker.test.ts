/* Regression test for the WEB reaction picker and chips (ui/agora.js),
   driven in jsdom — the web UI has no test harness of its own, and this repo
   already checks the shared emoji dataset from here (emoji.test.ts).
   Covers: picker open/search/empty state, pick → reaction toggle + recents,
   chip rendering (counts + own-reaction highlight), click-away and Escape,
   and recents validation against corrupt localStorage. */

import * as fs from "fs";
import * as path from "path";

// jsdom ships with jest-expo (via jest-environment-jsdom), so it is always present.
const { JSDOM } = require("jsdom");

/** Evaluates the real ui/ scripts plus `driver` in ONE scope (like
    sequential <script> tags), so the driver can touch top-level `let`
    state such as CURRENT_USER. Results come back via `window.__out`. */
function run(driver: string) {
  const dom = new JSDOM(
    `<!doctype html><body><div id="content"></div><div id="ago-log"></div></body>`,
    { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true },
  );
  const ui = path.join(__dirname, "../../ui");
  const scripts = ["icons.js", "emoji.js", "shim.js", "agora.js"]
    .map((f) => fs.readFileSync(path.join(ui, f), "utf8"))
    .join("\n;\n");
  dom.window.eval(`${scripts}\n;${driver}`);
  return dom.window;
}

describe("web reaction picker (ui/agora.js in jsdom)", () => {
  it("ignores corrupt or non-curated localStorage recents", () => {
    const w = run(`
      localStorage.setItem("agoEmojiRecent", '"hi"');
      const a = agoEmojiRecent();
      localStorage.setItem("agoEmojiRecent", JSON.stringify(["<img onerror=x>", "bad'entry", "👍"]));
      window.__out = { a, b: agoEmojiRecent() };
    `);
    expect([...w.__out.a]).toEqual([]);
    expect([...w.__out.b]).toEqual(["👍"]);
  });

  it("opens on document.body with search and an empty state", () => {
    const w = run(`agoReactPick(7, null);`);
    expect(w.document.getElementById("ago-emoji-pop")).toBeTruthy();
    expect(w.document.querySelectorAll(".ago-emoji-cell").length).toBeGreaterThan(500);

    w.eval('agoEmojiFilter("thumbs up")');
    const hits = [...w.document.querySelectorAll("#ago-emoji-body .ago-emoji-cell")].map(
      (e: Element) => e.textContent,
    );
    expect(hits).toContain("👍");

    w.eval('agoEmojiFilter("zzzznope")');
    expect(w.document.getElementById("ago-emoji-body")!.textContent).toContain(
      "No matching emoji",
    );
  });

  it("picking toggles the reaction for the open message, closes, records a recent", () => {
    const w = run(`
      window.__calls = [];
      agoToggleReaction = (mid, emoji) => { window.__calls.push([mid, emoji]); };
      agoReactPick(7, null);
      agoPickReaction("👍");
    `);
    expect([...w.__calls].map((c: string[]) => [...c])).toEqual([[7, "👍"]]);
    expect(w.document.getElementById("ago-emoji-pop")).toBeNull();
    expect(JSON.parse(w.localStorage.getItem("agoEmojiRecent")!)[0]).toBe("👍");
  });

  it("renders chips with counts and highlights the caller's own reaction", () => {
    const w = run(`
      CURRENT_USER = { username: "tom", display_name: "Tom", instance_admin: false };
      window.__out = {
        html: agoReactionsHTML({ id: 3, reactions: [
          { emoji: "👍", users: ["tom", "ana"] },
          { emoji: "🔥", users: ["ana"] },
        ]}),
        empty: agoReactionsHTML({ id: 4, reactions: [] }),
      };
    `);
    const html: string = w.__out.html;
    expect(html).toContain("👍");
    expect(html).toContain('<span class="rc">2</span>');
    expect(html).toContain('<span class="rc">1</span>');
    // exactly one chip (👍) carries the own-reaction highlight
    expect(html.match(/ago-react mine/g)).toHaveLength(1);
    // both chips toggle through agoToggleReaction for message 3
    expect(html.match(/agoToggleReaction\(3, /g)).toHaveLength(2);
    // messages with no reactions render nothing (the picker adds the first)
    expect(w.__out.empty).toBe("");
  });

  it("closes on click-away and on Escape", () => {
    const w = run(`agoReactPick(9, null);`);
    (w.document.body as HTMLElement).click();
    expect(w.document.getElementById("ago-emoji-pop")).toBeNull();

    const w2 = run(`
      agoReactPick(9, null);
      agoKeydown({ key: "Escape", shiftKey: false, preventDefault: () => {} }, null);
    `);
    expect(w2.document.getElementById("ago-emoji-pop")).toBeNull();
  });
});
