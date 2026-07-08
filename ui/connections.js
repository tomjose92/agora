/* Connections pane: link Pantheo instances (the app dials their
   /agora/connect endpoint) and issue pairing tokens for dial-in bridges
   (OpenClaw / Hermes / custom agents). */

let _connOpen = false;
let _connData = [];     // [{name, url, enabled, status}]
let _connInstance = null; // {id, name} — this app's declared identity
let _connTokens = [];   // [{token, name, created_at}]
let _connTimer = null;

function connToggle() {
  _connOpen = !_connOpen;
  const overlay = document.getElementById("conn-overlay");
  overlay.style.display = _connOpen ? "" : "none";
  clearInterval(_connTimer);
  if (_connOpen) {
    connLoad().catch(console.error);
    _connTimer = setInterval(() => connLoad().catch(() => {}), 4000);
  }
}

async function connLoad() {
  const [conns, tokens] = await Promise.all([
    api("/api/connections"),
    api("/api/pairing"),
  ]);
  _connData = conns.connections || [];
  _connInstance = conns.instance || null;
  _connTokens = tokens.tokens || [];
  connDraw();
  connRefreshBadge().catch(() => {});
}

/* Topbar dot: green when every enabled connection is live, amber when some
   are down, grey when none are configured. */
async function connRefreshBadge() {
  const el = document.getElementById("topbar-status");
  if (!el) return;
  let conns = _connData;
  if (!conns.length) {
    try { conns = (await api("/api/connections")).connections || []; } catch (e) { return; }
  }
  const enabled = conns.filter(c => c.enabled);
  const up = enabled.filter(c => c.status && c.status.connected);
  const agents = enabled.reduce((n, c) => n + ((c.status && c.status.agents) || []).length, 0);
  if (!enabled.length) {
    el.innerHTML = `<span class="conn-dot off"></span> no connections`;
  } else {
    const cls = up.length === enabled.length ? "on" : (up.length ? "part" : "err");
    el.innerHTML = `<span class="conn-dot ${cls}"></span> ${up.length}/${enabled.length} linked · ${agents} agent${agents === 1 ? "" : "s"}`;
  }
}

/* The web address a human would open for a linked instance: the ws(s)://…/
   agora/connect endpoint maps to the http(s) origin serving that Pantheo's UI. */
function connWebUrl(wsUrl) {
  try {
    const u = new URL(wsUrl);
    const scheme = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
    return `${scheme}//${u.host}/`;
  } catch (e) {
    return null;
  }
}

function connDraw() {
  const panel = document.getElementById("conn-panel");
  if (!panel || !_connOpen) return;
  // The 4s status poll redraws the panel; don't clobber in-progress typing.
  const active = document.activeElement;
  if (active && panel.contains(active) && active.tagName === "INPUT") return;
  const rows = _connData.map(c => {
    const st = c.status || {};
    const agents = (st.agents || []).map(a => esc(a.name || a.id)).join(", ");
    const dot = st.connected ? "on" : "err";
    const detail = st.connected
      ? (agents ? `agents: ${agents}` : "linked, no agents offered")
      : (st.last_error ? esc(String(st.last_error).slice(0, 120)) : "connecting…");
    const web = connWebUrl(c.url);
    const open = web
      ? `<a class="btn sm" href="${esc(web)}" target="_blank" rel="noopener" title="Open ${esc(web)}">Open</a>`
      : "";
    return `
    <div class="conn-row">
      <span class="conn-dot ${c.enabled ? dot : "off"}"></span>
      <div class="conn-row-main">
        <div class="conn-name">${esc(c.name)}</div>
        <div class="conn-url">${esc(c.url)}</div>
        <div class="conn-detail">${c.enabled ? detail : "disabled"}</div>
      </div>
      ${open}
      <button class="btn sm" onclick="connToggleEnabled('${esc(c.name)}', ${!c.enabled})">
        ${c.enabled ? "Disable" : "Enable"}</button>
      <button class="btn sm danger" onclick="connRemove('${esc(c.name)}')">Remove</button>
    </div>`;
  }).join("");
  const tokenRows = _connTokens.map(t => `
    <div class="conn-row">
      <span class="conn-dot off"></span>
      <div class="conn-row-main">
        <div class="conn-name">${esc(t.name)}</div>
        <div class="conn-url mono">${esc(t.token)}</div>
      </div>
      <button class="btn sm" onclick="connCopyToken('${esc(t.token)}')">Copy</button>
      <button class="btn sm danger" onclick="connRevokeToken('${esc(t.token)}')">Revoke</button>
    </div>`).join("");
  panel.innerHTML = `
    <div class="conn-head">
      <b>Connections</b>
      <button class="btn sm" onclick="connToggle()">✕</button>
    </div>
    <div class="conn-body">
      ${_connInstance ? `
      <h4>This Agora <span class="dim">— how linked instances label this app's chats</span></h4>
      <div class="conn-add">
        <input id="inst-name" value="${esc(_connInstance.name || "")}" placeholder="name (e.g. Home Agora)">
        <button class="btn sm primary" onclick="instRename()">Rename</button>
      </div>
      <p class="conn-hint">Sessions and channel bindings on a linked Pantheo carry this name
        (instance id <code>${esc((_connInstance.id || "").slice(0, 8))}</code>), so several Agoras stay distinct.</p>` : ""}
      <h4>Pantheo instances <span class="dim">— the app dials out to them</span></h4>
      ${rows || '<div class="dim conn-empty">None yet. Point at a Pantheo server\'s <code>/agora/connect</code> below.</div>'}
      <div class="conn-add">
        <input id="conn-name" placeholder="name (e.g. home)">
        <input id="conn-url" placeholder="wss://my-pantheo:8765/agora/connect">
        <input id="conn-token" placeholder="PANTHEO_API_TOKEN" type="password">
        <button class="btn sm primary" onclick="connAdd()">Link</button>
      </div>
      <p class="conn-hint">Use <code>ws://localhost:8765/agora/connect</code> for a Pantheo running
        on this machine, or the server's public <code>wss://</code> address for a remote one.
        Every agent with Agora enabled on that instance becomes available here.</p>
      <h4>Pairing tokens <span class="dim">— for agents that dial in (OpenClaw, Hermes, bridges)</span></h4>
      ${tokenRows || '<div class="dim conn-empty">No pairing tokens issued.</div>'}
      <div class="conn-add">
        <input id="pair-name" placeholder="label (e.g. openclaw-bridge)">
        <button class="btn sm primary" onclick="connCreateToken()">New token</button>
      </div>
      <p class="conn-hint">A bridge connects to <code>ws://this-host:port/agent/ws?token=…</code>
        and speaks the Agora agent protocol (see docs/protocol.md in the repo).</p>
    </div>`;
}

async function instRename() {
  const name = (document.getElementById("inst-name").value || "").trim();
  if (!name) { toast("Name required", { variant: "warn" }); return; }
  try {
    await apiPost("/api/instance", { name }, "PUT");
    toast("Renamed — relinking so endpoints pick it up…", { variant: "ok" });
    await connLoad();
  } catch (e) { toast("Rename failed: " + e.message, { variant: "warn" }); }
}

async function connAdd() {
  const name = (document.getElementById("conn-name").value || "").trim();
  const url = (document.getElementById("conn-url").value || "").trim();
  const token = (document.getElementById("conn-token").value || "").trim();
  if (!name || !url) { toast("Name and URL required", { variant: "warn" }); return; }
  try {
    await apiPost("/api/connections", { name, url, token });
    toast("Connection added — linking…", { variant: "ok" });
    await connLoad();
    renderAgora().catch(console.error);
  } catch (e) { toast("Couldn't add connection: " + e.message, { variant: "warn" }); }
}

async function connToggleEnabled(name, enabled) {
  try {
    await apiPost(`/api/connections/${encodeURIComponent(name)}`, { enabled }, "PUT");
    await connLoad();
  } catch (e) { toast("Update failed: " + e.message, { variant: "warn" }); }
}

async function connRemove(name) {
  try {
    await apiPost(`/api/connections/${encodeURIComponent(name)}`, {}, "DELETE");
    await connLoad();
  } catch (e) { toast("Remove failed: " + e.message, { variant: "warn" }); }
}

async function connCreateToken() {
  const name = (document.getElementById("pair-name").value || "bridge").trim();
  try {
    const resp = await apiPost("/api/pairing", { name });
    await connLoad();
    connCopyToken(resp.token);
  } catch (e) { toast("Couldn't create token: " + e.message, { variant: "warn" }); }
}

function connCopyToken(token) {
  navigator.clipboard && navigator.clipboard.writeText(token)
    .then(() => toast("Pairing token copied", { variant: "ok" }))
    .catch(() => toast(token));
}

async function connRevokeToken(token) {
  try {
    await apiPost(`/api/pairing/${encodeURIComponent(token)}`, {}, "DELETE");
    await connLoad();
  } catch (e) { toast("Revoke failed: " + e.message, { variant: "warn" }); }
}
