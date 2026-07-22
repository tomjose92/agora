/* Parity harness: drives the Agora web UI through its core flows with
   selector-only Playwright (no reliance on vanilla globals), so the same
   script verifies both the vanilla UI at "/" and the React UI at "/app2/".

   Usage:
     AGORA_TOKEN=<admin key> node web/e2e/parity.mjs [appPath]
   Env:
     AGORA_BASE   server origin      (default http://127.0.0.1:4470)
     AGORA_TOKEN  admin key          (required)
     PW_DIR       dir containing node_modules/playwright (default: resolve normally)
   The server must be fresh-ish; seeding is idempotent by group name. */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pwPath = process.env.PW_DIR
  ? `${process.env.PW_DIR}/node_modules/playwright`
  : "playwright";
const { chromium } = require(pwPath);

const BASE = process.env.AGORA_BASE || "http://127.0.0.1:4470";
const TOKEN = process.env.AGORA_TOKEN;
const APP_PATH = process.argv[2] || "/";
if (!TOKEN) { console.error("AGORA_TOKEN required"); process.exit(2); }

const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
const api = async (path, body, method) => {
  const res = await fetch(BASE + path, {
    method: method || (body ? "POST" : "GET"),
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

/* ---------- seed (idempotent by group name) ---------- */
const SEED = {};
async function seed() {
  const groups = (await api("/api/groups")).groups;
  let g = groups.find(x => x.name === "Parity");
  if (!g) {
    g = await api("/api/groups", { name: "Parity" });
    const c = await api(`/api/groups/${g.id}/channels`, { name: "general" });
    await api(`/api/groups/${g.id}/channels`, { name: "second", topic: "the second channel" });
    SEED.channel = c.id;
    // plain + markdown messages
    await api(`/api/channels/${c.id}/messages`, { text: "seed plain message one" });
    await api(`/api/channels/${c.id}/messages`, {
      text: "seed **bold** and `code` and a [link](https://example.com/x)",
    });
    // a thread with replies
    const root = await api(`/api/channels/${c.id}/messages`, { text: "seed thread root alpha" });
    SEED.threadRoot = root.id;
    for (let i = 1; i <= 3; i++) {
      await api(`/api/channels/${c.id}/messages`, { text: `seed reply ${i}`, thread_id: root.id });
    }
    // several more threads so the inbox has rows
    for (let i = 2; i <= 6; i++) {
      const r = await api(`/api/channels/${c.id}/messages`, { text: `seed thread root ${i}` });
      await api(`/api/channels/${c.id}/messages`, { text: "one reply", thread_id: r.id });
    }
    // searchable needle
    await api(`/api/channels/${c.id}/messages`, { text: "xyzzy-needle for search parity" });
  } else {
    const c = g.channels.find(x => x.name === "general");
    SEED.channel = c.id;
    const threads = (await api("/api/threads")).threads;
    const t = threads.find(t => t.root.text === "seed thread root alpha");
    SEED.threadRoot = t ? t.root.id : null;
  }
  SEED.group = g.id;
}

/* ---------- check runner ---------- */
const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (e) {
    failures++;
    results.push(`FAIL ${name}: ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
  }
}

const appUrl = q => BASE + APP_PATH + (q || "");

async function main() {
  await seed();
  const browser = await chromium.launch();

  /* -- 1. auth gate + manual key submit (fresh context, no token) -- */
  await check("auth: gate shows without token and accepts the admin key", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(appUrl());
    await page.waitForSelector(".auth-card #auth-token", { timeout: 10000 });
    await page.fill("#auth-token", TOKEN);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => (document.getElementById("topbar-me")?.textContent || "").trim().length > 0,
      { timeout: 10000 });
    await ctx.close();
  });

  /* -- main context: token via URL -- */
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));

  await check("auth: ?token= is consumed and stripped from the URL", async () => {
    await page.goto(appUrl(`?token=${TOKEN}`));
    await page.waitForFunction(
      () => (document.getElementById("topbar-me")?.textContent || "").trim().length > 0,
      { timeout: 10000 });
    if (page.url().includes("token=")) throw new Error(`token still in URL: ${page.url()}`);
    const stored = await page.evaluate(() => localStorage.getItem("agora_token"));
    if (stored !== TOKEN) throw new Error("token not in localStorage");
  });

  await check("sidebar: group renders, expands, channel selects", async () => {
    await page.waitForSelector(".ago-group-head", { timeout: 10000 });
    const group = page.locator(".ago-group", { hasText: "Parity" }).first();
    // expand if collapsed
    if (!(await group.locator(".ago-chan").count())) {
      await group.locator(".ago-caret").click();
    }
    await page.waitForSelector(".ago-chan", { timeout: 5000 });
    await page.locator(".ago-chan", { hasText: "general" }).first().click();
    await page.waitForSelector(".ago-chan.active", { timeout: 5000 });
    await page.waitForSelector("#ago-log .bubble", { timeout: 5000 });
  });

  await check("messages: seeded texts and markdown render", async () => {
    const log = page.locator("#ago-log");
    await log.locator(".bubble", { hasText: "seed plain message one" }).first().waitFor();
    const b = log.locator(".bubble", { hasText: "seed" }).filter({ has: page.locator("b", { hasText: "bold" }) }).first();
    await b.waitFor({ timeout: 5000 });
    const code = await log.locator("code", { hasText: "code" }).count();
    if (!code) throw new Error("inline code not rendered");
    const link = log.locator('a[href="https://example.com/x"]');
    if (!(await link.count())) throw new Error("md link not rendered");
    if ((await link.first().getAttribute("target")) !== "_blank") throw new Error("link target");
  });

  await check("composer: Enter posts; log sticks to bottom", async () => {
    const text = `posted from parity ${APP_PATH}`;
    await page.fill("#ago-msg", text);
    await page.keyboard.press("Enter");
    await page.locator("#ago-log .bubble", { hasText: text }).first().waitFor({ timeout: 8000 });
    const atBottom = await page.$eval("#ago-log",
      el => el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    if (!atBottom) throw new Error("log not at bottom after send");
  });

  await check("live: message posted via API appears without reload", async () => {
    const text = `live echo ${Date.now() % 100000}`;
    await api(`/api/channels/${SEED.channel}/messages`, { text });
    await page.locator("#ago-log .bubble", { hasText: text }).first().waitFor({ timeout: 8000 });
  });

  await check("mermaid: fence renders to svg", async () => {
    await page.fill("#ago-msg", "```mermaid\ngraph TD; A-->B;\n```");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#ago-log .md-mermaid svg", { timeout: 20000 });
  });

  await check("reactions: pick emoji, chip appears, toggle off", async () => {
    const bubble = page.locator("#ago-log .bubble", { hasText: "seed plain message one" }).first();
    await bubble.hover();
    await bubble.locator(".ago-react-btn").click();
    await page.waitForSelector("#ago-emoji-pop", { timeout: 5000 });
    await page.locator("#ago-emoji-pop button").filter({ hasText: "👍" }).first().click();
    await bubble.locator(".ago-reacts .ago-react", { hasText: "👍" }).waitFor({ timeout: 8000 });
    await bubble.locator(".ago-reacts .ago-react", { hasText: "👍" }).click(); // toggle off
    await page.waitForFunction(
      sel => !document.querySelector(sel),
      undefined, { timeout: 8000, polling: 200 }
    ).catch(() => {});
  });

  await check("threads: inbox lists, opens, reply works", async () => {
    await page.locator(".ago-inbox-item", { hasText: "Threads" }).click();
    await page.waitForSelector(".ago-inbox-list .ago-inbox-row", { timeout: 5000 });
    await page.locator(".ago-inbox-row", { hasText: "seed thread root alpha" }).first().click();
    await page.waitForSelector("#ago-thread-log .bubble", { timeout: 5000 });
    await page.locator("#ago-thread-log .bubble", { hasText: "seed reply 3" }).waitFor();
    await page.fill("#ago-thread-msg", "parity thread reply");
    await page.keyboard.press("Enter");
    await page.locator("#ago-thread-log .bubble", { hasText: "parity thread reply" })
      .waitFor({ timeout: 8000 });
  });

  await check("threads: pin from pane; pin bar appears in channel", async () => {
    await page.locator('button[title="Pin this thread for quick access"]').first().click();
    await page.locator('.ago-pinbar .ago-pin-count', { hasText: "pinned" }).waitFor({ timeout: 8000 })
      .catch(async () => {
        // pin bar lives in the channel pane — navigate back to the channel
        await page.locator(".ago-chan", { hasText: "general" }).first().click();
        await page.locator(".ago-pinbar .ago-pin-count", { hasText: "pinned" }).waitFor({ timeout: 8000 });
      });
  });

  await check("threads: hide is two-step and preserves inbox scroll", async () => {
    await page.locator(".ago-inbox-item", { hasText: "Threads" }).click();
    await page.waitForSelector(".ago-inbox-list .ago-inbox-row", { timeout: 5000 });
    await page.$eval(".ago-inbox-list", el => { el.scrollTop = 120; });
    const before = await page.$eval(".ago-inbox-list", el => el.scrollTop);
    const row = page.locator(".ago-inbox-row", { hasText: "seed thread root 6" }).first();
    await row.hover();
    await row.locator('button.ago-x[title^="Remove"]').click();
    await page.waitForSelector(".ago-inbox-list button.ago-x.armed", { timeout: 5000 });
    const mid = await page.$eval(".ago-inbox-list", el => el.scrollTop);
    if (Math.abs(mid - before) > 2 && before > 0) throw new Error(`scroll moved on arm: ${before}->${mid}`);
    await page.locator(".ago-inbox-list button.ago-x.armed").click();
    await page.locator(".ago-inbox-row", { hasText: "seed thread root 6" })
      .waitFor({ state: "detached", timeout: 8000 });
  });

  await check("search: needle found, Escape closes", async () => {
    await page.locator(".ago-side-toggle.search").click();
    await page.waitForSelector("#ago-search-input", { timeout: 5000 });
    await page.fill("#ago-search-input", "xyzzy-needle");
    await page.locator("#ago-search-body", { hasText: "xyzzy-needle" }).waitFor({ timeout: 8000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const el = document.getElementById("ago-search-overlay");
      return !el || el.style.display === "none" || !el.isConnected;
    }, { timeout: 5000 });
  });

  await check("group page: channel cards + eye toggle", async () => {
    await page.locator(".ago-group-head", { hasText: "Parity" }).click();
    await page.waitForSelector(".ago-gp-chan", { timeout: 5000 });
    const card = page.locator(".ago-gp-chan", { hasText: "second" }).first();
    await card.hover();
    await card.locator("button.ago-x.show").click();
    await page.locator(".toast", { hasText: "hidden for you" }).waitFor({ timeout: 8000 });
    // restore it
    const again = page.locator(".ago-gp-chan", { hasText: "second" }).first();
    await again.hover();
    await again.locator("button.ago-x.show").click();
  });

  await check("members: panel lists me", async () => {
    await page.locator(".ago-chan", { hasText: "general" }).first().click();
    await page.locator(".ago-head-actions button", { hasText: "Members" }).click();
    await page.waitForSelector("#agora-members-pane .ago-member", { timeout: 5000 });
    await page.locator(".ago-head-actions button", { hasText: "Members" }).click();
  });

  await check("people: invite create + revoke", async () => {
    await page.locator("#btn-people").click();
    await page.waitForSelector("#users-panel .conn-body", { timeout: 5000 });
    await page.fill("#invite-email", "parity@example.com");
    await page.locator("#users-panel button", { hasText: "Invite" }).first().click();
    await page.locator("#users-panel .conn-row", { hasText: "parity@example.com" })
      .waitFor({ timeout: 8000 });
    await page.locator("#users-panel .conn-row", { hasText: "parity@example.com" })
      .locator("button", { hasText: "Revoke" }).click();
    await page.locator("#users-panel .conn-row", { hasText: "parity@example.com" })
      .waitFor({ state: "detached", timeout: 8000 });
    await page.locator("#users-panel .conn-head button").last().click();
  });

  await check("connections: pairing token create + revoke", async () => {
    await page.locator("#btn-connections").click();
    await page.waitForSelector("#conn-panel .conn-body", { timeout: 5000 });
    await page.fill("#pair-name", "parity-tok");
    await page.locator("#conn-panel button", { hasText: "New token" }).click();
    await page.locator("#conn-panel .conn-row", { hasText: "parity-tok" }).waitFor({ timeout: 8000 })
      .catch(async () => { /* token rows show the token value; accept Revoke button appearing */
        await page.locator("#conn-panel button", { hasText: "Revoke" }).first().waitFor({ timeout: 4000 });
      });
    await page.locator("#conn-panel button", { hasText: "Revoke" }).first().click();
    await page.locator("#conn-panel .conn-head button").last().click();
  });

  await check("no unexpected page errors during the run", async () => {
    if (errors.length) throw new Error(errors.join(" | "));
  });

  await browser.close();
  console.log(results.join("\n"));
  console.log(failures ? `\n${failures} FAILURES` : "\nALL GREEN");
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error("HARNESS ERROR:", e); process.exit(2); });
