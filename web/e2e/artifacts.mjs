/* Regression harness for map artifacts: injects a real agent-authored map
   artifact over the dial-in WebSocket protocol (so the Rust sanitizer runs),
   then drives the web UI through the card -> viewer -> filter -> place flow.

   Usage:
     AGORA_TOKEN=<admin key> node web/e2e/artifacts.mjs [appPath]
   Env:
     AGORA_BASE   server origin      (default http://127.0.0.1:4470)
     AGORA_TOKEN  admin key          (required)
     PW_DIR       dir containing node_modules/playwright (default: resolve normally)
   The server must serve web/dist and, for real tiles, have `map_style_url`
   set in config.json — the flow works either way (SVG fallback otherwise). */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pwPath = process.env.PW_DIR ? `${process.env.PW_DIR}/node_modules/playwright` : "playwright";
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* A compact but multi-city Turkey itinerary: enough places per city to force
   clustering at country zoom, days/regions/routes to exercise every filter. */
const AGENT_ID = "map-bot";
const ARTIFACT = {
  id: "turkey-7-days", type: "map", version: 1,
  title: "Turkey · 7-day itinerary", summary: "Istanbul, Cappadocia, and Antalya",
  data: {
    regions: [
      { id: "istanbul", label: "Istanbul", center: { lat: 41.0082, lng: 28.9784 } },
      { id: "cappadocia", label: "Cappadocia", center: { lat: 38.6431, lng: 34.8289 } },
      { id: "antalya", label: "Antalya", center: { lat: 36.8969, lng: 30.7133 } },
    ],
    days: [
      { id: "day-1", number: 1, label: "Historic Istanbul", region_id: "istanbul", place_ids: ["hagia", "blue-mosque", "topkapi"] },
      { id: "day-4", number: 4, label: "Cappadocia valleys", region_id: "cappadocia", place_ids: ["goreme", "uchisar"] },
      { id: "day-6", number: 6, label: "Antalya old town", region_id: "antalya", place_ids: ["kaleici"] },
    ],
    places: [
      { id: "hagia", label: "Hagia Sophia", position: { lat: 41.0086, lng: 28.9802 }, region_id: "istanbul", day_ids: ["day-1"], order: 1, category: "sight", description: "Begin early before the crowds.", start_time: "09:00", duration_minutes: 120 },
      { id: "blue-mosque", label: "Blue Mosque", position: { lat: 41.0054, lng: 28.9768 }, region_id: "istanbul", day_ids: ["day-1"], order: 2, category: "sight" },
      { id: "topkapi", label: "Topkapı Palace", position: { lat: 41.0115, lng: 28.9834 }, region_id: "istanbul", day_ids: ["day-1"], order: 3, category: "sight" },
      { id: "goreme", label: "Göreme Open-Air Museum", position: { lat: 38.6431, lng: 34.8452 }, region_id: "cappadocia", day_ids: ["day-4"], order: 1, category: "sight" },
      { id: "uchisar", label: "Uçhisar Castle", position: { lat: 38.6300, lng: 34.8050 }, region_id: "cappadocia", day_ids: ["day-4"], order: 2, category: "nature" },
      { id: "kaleici", label: "Kaleiçi Old Town", position: { lat: 36.8845, lng: 30.7056 }, region_id: "antalya", day_ids: ["day-6"], order: 1, category: "sight" },
    ],
    routes: [
      { id: "overview", kind: "overview", label: "Turkey route", region_ids: ["istanbul", "cappadocia", "antalya"], place_ids: [],
        coordinates: [[28.9784, 41.0082], [34.8289, 38.6431], [30.7133, 36.8969]] },
    ],
  },
};

const SEED = {};
async function seed() {
  const groups = (await api("/api/groups")).groups;
  let g = groups.find(x => x.name === "Artifacts");
  if (!g) {
    g = await api("/api/groups", { name: "Artifacts" });
    const c = await api(`/api/groups/${g.id}/channels`, { name: "maps" });
    SEED.channel = c.id;
  } else {
    SEED.channel = g.channels.find(x => x.name === "maps").id;
  }
  SEED.group = g.id;
}

/* Connect a dial-in agent, register it, make it a channel member, and post the
   artifact. The Rust `sanitize_artifacts` path runs here — exactly what a real
   Pantheo/CLI agent would drive. */
async function injectArtifact() {
  const { token } = await api("/api/pairing", { name: "map-bot" });
  const wsUrl = `${BASE.replace(/^http/, "ws")}/agent/ws?token=${token}`;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("agent ws failed to open")), { once: true });
  });
  ws.send(JSON.stringify({
    type: "hello",
    agents: [{ id: AGENT_ID, name: "Map Bot", requires_mention: false }],
  }));
  await sleep(400); // let register_agent persist the agent before we add it
  await api(`/api/groups/${SEED.group}/members`, {
    member_type: "agent", member_id: AGENT_ID, channel_id: SEED.channel,
  });
  ws.send(JSON.stringify({
    type: "post", agent_id: AGENT_ID, channel_id: SEED.channel,
    text: "Here is your seven-day Turkey itinerary.", artifacts: [ARTIFACT],
  }));
  await sleep(600);
  ws.close();
}

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

async function openChannel(page) {
  await page.goto(appUrl(`?token=${TOKEN}`));
  await page.waitForFunction(
    () => (document.getElementById("topbar-me")?.textContent || "").trim().length > 0,
    { timeout: 10000 });
  await page.locator('.ago-chan:has-text("maps")').first().click();
  await page.locator(".ago-map-card").first().waitFor({ timeout: 10000 });
}

async function main() {
  await seed();
  await injectArtifact();

  await check("server: artifact landed sanitized in message meta", async () => {
    const msgs = await api(`/api/channels/${SEED.channel}/messages`);
    const list = Array.isArray(msgs) ? msgs : msgs.messages;
    const hit = list.find(m => m.meta?.artifacts?.some(a => a.type === "map"));
    if (!hit) throw new Error("no message carries a map artifact");
    const art = hit.meta.artifacts.find(a => a.type === "map");
    if (art.data.places.length !== 6) throw new Error(`expected 6 places, got ${art.data.places?.length}`);
  });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));

  await check("card: map artifact renders in the channel with summary + chips", async () => {
    await openChannel(page);
    const card = page.locator(".ago-map-card").first();
    await card.locator(".ago-map-card-head strong", { hasText: "Turkey" }).waitFor({ timeout: 8000 });
    const chips = await card.locator(".ago-map-region-chips button").count();
    if (chips !== 3) throw new Error(`expected 3 region chips, got ${chips}`);
  });

  await check("viewer: opens from the card and shows the interactive map", async () => {
    await page.locator(".ago-map-card-head").first().click();
    await page.locator(".ago-map-panel").waitFor({ timeout: 8000 });
    // A canvas mounts regardless of WebGL: MapLibre (.ago-map-gl) or SVG fallback.
    await page.locator(".ago-map-canvas .ago-map-gl, .ago-map-canvas .ago-map-graphic")
      .first().waitFor({ timeout: 8000 });
  });

  await check("viewer: area filter narrows the place list to that city", async () => {
    const areaSelect = page.locator(".ago-map-filters select").first();
    await areaSelect.selectOption({ label: "Cappadocia" });
    await page.waitForTimeout(300);
    const count = await page.locator(".ago-place-list button").count();
    if (count !== 2) throw new Error(`expected 2 Cappadocia places, got ${count}`);
  });

  await check("viewer: reset restores all places", async () => {
    await page.locator(".ago-map-filters button", { hasText: "Reset view" }).click();
    await page.waitForTimeout(300);
    const count = await page.locator(".ago-place-list button").count();
    if (count !== 6) throw new Error(`expected 6 places after reset, got ${count}`);
  });

  await check("viewer: selecting a place shows details + a keyless Google Maps link", async () => {
    await page.locator(".ago-place-list button", { hasText: "Hagia Sophia" }).click();
    await page.locator(".ago-map-details h3", { hasText: "Hagia Sophia" }).waitFor({ timeout: 5000 });
    const href = await page.locator(".ago-map-actions a").first().getAttribute("href");
    if (!href || !href.includes("google.com/maps") || !href.includes("api=1")) {
      throw new Error(`unexpected maps link: ${href}`);
    }
    if (!href.includes("41.0086") || !href.includes("28.9802")) {
      throw new Error(`maps link missing place coords: ${href}`);
    }
  });

  await check("viewer: Escape closes the modal", async () => {
    await page.keyboard.press("Escape");
    await page.locator(".ago-map-panel").waitFor({ state: "detached", timeout: 5000 });
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
