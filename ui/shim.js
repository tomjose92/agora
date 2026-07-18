/* Standalone shell shim: the helpers the chat page used to get from the
   Pantheo admin SPA (api/apiPost/toast/esc/mdLite/...), reimplemented for the
   Agora app. Single-user: the admin key arrives once via ?token= (the
   desktop shell appends it) and is kept in localStorage after that. */

/* ---------- auth ---------- */
let AUTH_ERROR = "";
/* Invite-link token from /join/{token} (carried in the fragment). Kept in
   sessionStorage so it survives the Google round-trip redirect. */
let JOIN_TOKEN = "";
(function initToken() {
  const params = new URLSearchParams(location.search);
  const t = params.get("token");
  if (t) {
    localStorage.setItem("agora_token", t);
    // Drop the token from the visible URL/history.
    history.replaceState(null, "", location.pathname);
  }
  // Google sign-in lands back here with the session token (or an error) in
  // the URL fragment, so it never reaches server logs.
  if (location.hash.length > 1) {
    const frag = new URLSearchParams(location.hash.slice(1));
    const session = frag.get("agora_session");
    if (session) localStorage.setItem("agora_token", session);
    AUTH_ERROR = frag.get("auth_error") || "";
    const join = frag.get("join");
    if (join) sessionStorage.setItem("agora_join", join);
    if (session || AUTH_ERROR || join) history.replaceState(null, "", location.pathname);
  }
  JOIN_TOKEN = sessionStorage.getItem("agora_join") || "";
})();
function sessionToken() { return localStorage.getItem("agora_token") || ""; }
function authHeaders() {
  const t = sessionToken();
  return t ? { "Authorization": "Bearer " + t } : {};
}
/* Filled from /api/me at boot; `instance_admin` gates the operator-only UI
   (Connections, Users & invites). Group-level powers ride on each group's
   `role` from /api/groups instead. */
let CURRENT_USER = { username: "", display_name: "", instance_admin: false };
function isOwner() { return !!(CURRENT_USER && CURRENT_USER.instance_admin); }

/* Profile self-service: clicking your name in the topbar renames you.
   New messages pick up the name automatically; old ones keep the name
   they were posted under. */
async function meRename() {
  const next = window.prompt(
    "Display name (leave blank to use your username):",
    CURRENT_USER.display_name || CURRENT_USER.username);
  if (next === null) return;
  try {
    const me = await apiPost("/api/me", { display_name: next.trim() }, "PATCH");
    CURRENT_USER.display_name = me.display_name || CURRENT_USER.username;
    const meEl = document.getElementById("topbar-me");
    if (meEl) meEl.textContent = CURRENT_USER.display_name;
    toast("Display name updated", { variant: "ok" });
  } catch (e) {
    toast("Couldn't update your name: " + (e.message || e), { variant: "error" });
  }
}
const active = "agora";   // the chat page checks which SPA tab is showing

/* ---------- api ---------- */
async function api(path) {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) { authGate(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(await errDetail(res));
  return res.json();
}
async function apiPost(path, body, method = "POST") {
  const res = await fetch(path, {
    method,
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { authGate(); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(await errDetail(res));
  return res.json();
}
async function errDetail(res) {
  let detail = await res.text();
  try { detail = JSON.parse(detail).detail || detail; } catch (e) {}
  return detail;
}

/* No/bad token: the sign-in card (headless deployments land here; the desktop
   app rarely does because the shell opens the UI with ?token=). Google leads
   when the server offers it; the admin key is always available. */
const AUTH_ERROR_TEXT = {
  no_access: "That account isn't a member here — ask an admin to invite your email.",
  disabled: "Your account has been disabled on this instance.",
  google_access_denied: "Google sign-in was cancelled.",
  state: "Sign-in expired — try again.",
  invite_invalid: "That invite link has been used or has expired — ask for a new one.",
};
function authGate() {
  if (document.getElementById("auth-gate")) return;
  const el = document.createElement("div");
  el.id = "auth-gate";
  const errText = AUTH_ERROR
    ? (AUTH_ERROR_TEXT[AUTH_ERROR] || "Google sign-in failed — try again.")
    : "";
  AUTH_ERROR = "";
  el.innerHTML = `<div class="auth-card">
    <div class="auth-brand"><img src="/icon.png" alt=""><h1>Agora</h1></div>
    <p class="auth-sub" id="auth-hint">Admin sign-in: paste this server's admin
       key (printed in its log).</p>
    <button class="btn google" id="auth-google" style="display:none"
            onclick="location.href='/api/auth/google/start' + (JOIN_TOKEN ? '?invite=' + encodeURIComponent(JOIN_TOKEN) : '')">
      <svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Continue with Google</button>
    <div class="auth-divider" id="auth-divider" style="display:none">or</div>
    <div id="auth-token-form">
      <label for="auth-token">Admin key</label>
      <input id="auth-token" type="password"
             placeholder="printed in the server log / config.json"
             autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn primary" onclick="authSubmit()">Sign in as admin</button>
    </div>
    <button class="auth-link" id="auth-token-toggle" style="display:none">
      Sign in as admin</button>
    <p class="auth-error" id="auth-error">${esc(errText)}</p>
  </div>`;
  document.body.appendChild(el);
  const input = document.getElementById("auth-token");
  input.focus();
  input.onkeydown = e => { if (e.key === "Enter") authSubmit(); };
  document.getElementById("auth-token-toggle").onclick = () => {
    document.getElementById("auth-token-form").style.display = "";
    document.getElementById("auth-divider").style.display = "";
    document.getElementById("auth-token-toggle").style.display = "none";
    input.focus();
  };
  fetch("/api/auth/config").then(r => r.json()).then(cfg => {
    if (cfg.google && cfg.google.enabled) {
      // Google-first: tuck the token form behind a link.
      document.getElementById("auth-google").style.display = "";
      document.getElementById("auth-token-form").style.display = "none";
      document.getElementById("auth-token-toggle").style.display = "";
      document.getElementById("auth-hint").textContent = JOIN_TOKEN
        ? "You've been invited to this Agora — sign in with Google to join."
        : "Sign in with Google — members and invited emails get in.";
    }
  }).catch(() => {});
}
async function authSubmit() {
  const t = (document.getElementById("auth-token").value || "").trim();
  if (!t) return;
  localStorage.setItem("agora_token", t);
  try {
    await api("/api/me");
    document.getElementById("auth-gate").remove();
    boot();
  } catch (e) {
    toast("That token didn't work", { variant: "warn" });
  }
}

/* ---------- formatting (ported from admin/static/js/format.js) ---------- */
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function mdLite(s) {
  let t = esc(s);
  const slots = [];
  const stash = html => `\u0000${slots.push(html) - 1}\u0000`;
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    code = code.replace(/\n$/, "");
    // A mermaid fence keeps its code block visible inside a marker div;
    // agoRenderMermaid() swaps it for the rendered SVG after each redraw
    // (and leaves the code standing when the graph doesn't parse).
    if (lang.toLowerCase() === "mermaid") {
      return stash(`<div class="md-mermaid"><pre class="md-pre">${code}</pre></div>`);
    }
    return stash(`<pre class="md-pre"${lang ? ` data-lang="${lang}"` : ""}>${code}</pre>`);
  });
  t = t.replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${c}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label, url) => stash(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`));
  t = t.replace(/(^|\s)(https?:\/\/[^\s<\u0000]+)/g,
    (_, pre, url) => pre + stash(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");
  t = t.replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");
  t = t.replace(
    /(^|\n)(\|[^\n]*\|[ \t]*\r?\n\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*(?:\r?\n\|[^\n]*\|[ \t]*)*)\r?\n?/g,
    (_, pre, block) => {
      const rows = block.trim().split(/\r?\n/).map(line =>
        line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim()));
      const aligns = rows[1].map(c =>
        /^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : "");
      const cell = (tag, c, i) =>
        `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${c}</${tag}>`;
      const head = `<tr>${rows[0].map((c, i) => cell("th", c, i)).join("")}</tr>`;
      const body = rows.slice(2).map(r =>
        `<tr>${r.map((c, i) => cell("td", c, i)).join("")}</tr>`).join("");
      return pre + `<div class="md-table-wrap"><table class="md-table"><thead>${head}</thead>`
        + `<tbody>${body}</tbody></table></div>`;
    });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}
function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = (el.scrollHeight + 2) + "px";
}
function fmtTs(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString([], {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});
}

/* ---------- toasts (ported from admin/static/js/app.js) ---------- */
function toast(message, { actionLabel, onAction, variant } = {}) {
  const host = document.getElementById("toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast" + (variant ? " " + variant : "");
  const dismiss = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);
  };
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  el.appendChild(msg);
  if (actionLabel && onAction) {
    const act = document.createElement("button");
    act.className = "toast-action";
    act.textContent = actionLabel;
    act.onclick = () => { dismiss(); try { onAction(); } catch (e) { console.error(e); } };
    el.appendChild(act);
  }
  const x = document.createElement("button");
  x.className = "toast-x";
  x.setAttribute("aria-label", "Dismiss");
  x.innerHTML = icon("x");
  x.onclick = dismiss;
  el.appendChild(x);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(dismiss, 8000);
}

/* ---------- server badge ---------- */
/* Topbar pill answering "where is this Agora?": a loopback host means the
   server runs inside this app (or on this machine) and the data lives here;
   anything else is a remote deployment we're a client of. */
function renderServerBadge() {
  const el = document.getElementById("server-badge");
  if (!el) return;
  const host = location.hostname;
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (local) {
    el.innerHTML = '<span class="srv-dot local"></span>Local server';
    el.title = "This Agora runs on this computer — messages and data are stored here.";
  } else {
    el.innerHTML = '<span class="srv-dot remote"></span>Remote · <b>' + esc(host) + "</b>";
    el.title = "Connected to " + location.origin +
      " — messages and data live on that server.";
  }
  document.title = local ? "Agora — Local" : "Agora — " + host;
}

/* ---------- boot ---------- */
async function boot() {
  renderServerBadge();
  try {
    const me = await api("/api/me");
    CURRENT_USER = {
      username: me.username,
      display_name: me.display_name || me.username,
      instance_admin: !!me.instance_admin,
    };
    _agoVoiceOK = !!me.voice;   // server has STT/TTS: show the voice controls
    _agoSearchAI = !!me.search_ai;   // server can answer /api/search/ask
    // Signed in — any pending invite link is consumed or moot.
    sessionStorage.removeItem("agora_join");
    JOIN_TOKEN = "";
  } catch (e) {
    return;   // authGate is showing
  }
  // Who am I + operator-only topbar entries (Connections, People).
  const meEl = document.getElementById("topbar-me");
  if (meEl) meEl.textContent = CURRENT_USER.display_name || CURRENT_USER.username;
  const adminOnly = ["btn-connections", "btn-people"];
  for (const id of adminOnly) {
    const el = document.getElementById(id);
    if (el) el.style.display = isOwner() ? "" : "none";
  }
  renderAgora().catch(console.error);
  if (isOwner()) connRefreshBadge().catch(() => {});
}
