/* Regression test for the WEB composer's emoji picker (ui/agora.js), driven
   in jsdom — the web UI has no test harness of its own, and this repo
   already checks the shared emoji dataset from here (emoji.test.ts).
   Covers: open without redraw (caret preserved), search, pick-at-caret,
   recents (including corrupt localStorage), click-away, and Escape. */

import * as fs from "fs";
import * as path from "path";

// jsdom ships with jest-expo (via jest-environment-jsdom), so it is always present.
const { JSDOM } = require("jsdom");

function boot() {
  const dom = new JSDOM(
    `<!doctype html><body><div id="content"></div>
     <div class="chat-input"><textarea id="ago-msg"></textarea></div></body>`,
    { runScripts: "outside-only", url: "http://localhost/", pretendToBeVisual: true },
  );
  const ui = path.join(__dirname, "../../ui");
  const scripts = ["icons.js", "emoji.js", "shim.js", "agora.js"]
    .map((f) => fs.readFileSync(path.join(ui, f), "utf8"))
    .join("\n;\n");
  // One eval scope, like sequential <script> tags sharing top-level bindings.
  dom.window.eval(
    `${scripts}
     ;document.querySelector(".chat-input").insertAdjacentHTML("beforeend", agoEmojiBtnHTML(null));`,
  );
  return dom.window;
}

describe("web emoji picker (ui/agora.js in jsdom)", () => {
  it("ignores corrupt or non-curated localStorage recents", () => {
    const w = boot();
    w.localStorage.setItem("agoEmojiRecent", '"hi"');
    expect(w.eval("agoEmojiRecent()")).toEqual([]);
    w.localStorage.setItem("agoEmojiRecent", JSON.stringify(["<img onerror=x>", "bad'entry", "👍"]));
    expect(w.eval("agoEmojiRecent()")).toEqual(["👍"]);
  });

  it("opens without redrawing the composer, preserving the caret", () => {
    const w = boot();
    const input = w.document.getElementById("ago-msg") as HTMLTextAreaElement;
    input.value = "hello world";
    input.focus();
    input.setSelectionRange(5, 5);
    w.eval("agoEmojiToggle(null)");
    expect(w.document.getElementById("ago-emoji-pop")).toBeTruthy();
    expect(w.document.querySelectorAll(".ago-emoji-cell").length).toBeGreaterThan(500);
    expect(input.selectionStart).toBe(5);
    const cats = [...w.document.querySelectorAll(".ago-emoji-cat")].map((e: Element) =>
      e.textContent!.trim(),
    );
    expect(cats).toEqual(expect.arrayContaining(["Smileys", "Symbols"]));
  });

  it("search narrows the grid and shows an empty state on no match", () => {
    const w = boot();
    w.eval("agoEmojiToggle(null)");
    w.eval('agoEmojiFilter(null, "thumbs up")');
    const hits = [...w.document.querySelectorAll("#ago-emoji-body .ago-emoji-cell")].map(
      (e: Element) => e.textContent,
    );
    expect(hits).toContain("👍");
    w.eval('agoEmojiFilter(null, "zzzznope")');
    expect(w.document.getElementById("ago-emoji-body")!.textContent).toContain(
      "No matching emoji",
    );
  });

  it("picks at the caret, replaces selections, closes, and records recents", () => {
    const w = boot();
    const input = w.document.getElementById("ago-msg") as HTMLTextAreaElement;
    input.value = "hello world";
    input.focus();
    input.setSelectionRange(5, 5);
    w.eval("agoEmojiToggle(null)");
    w.eval('agoPickEmoji(null, "👍")');
    expect(input.value).toBe("hello👍 world");
    expect(input.selectionStart).toBe(7);
    expect(w.document.getElementById("ago-emoji-pop")).toBeNull();
    expect(JSON.parse(w.localStorage.getItem("agoEmojiRecent")!)[0]).toBe("👍");

    input.setSelectionRange(1, 2);
    w.eval('agoPickEmoji(null, "🔥")');
    expect(input.value).toBe("h🔥llo👍 world");

    // reopen: recents lead the sections, newest first
    w.eval("agoEmojiToggle(null)");
    const body = w.document.getElementById("ago-emoji-body")!.innerHTML;
    expect(body).toContain("Recently used");
    expect(body.indexOf("🔥")).toBeLessThan(body.indexOf("😀"));
  });

  it("closes on click-away and on Escape without leaving stale DOM", () => {
    const w = boot();
    w.eval("agoEmojiToggle(null)");
    (w.document.body as HTMLElement).click();
    expect(w.document.getElementById("ago-emoji-pop")).toBeNull();

    w.eval("agoEmojiToggle(null)");
    w.eval('agoKeydown({ key: "Escape", shiftKey: false, preventDefault: () => {} }, null)');
    expect(w.document.getElementById("ago-emoji-pop")).toBeNull();
  });
});
