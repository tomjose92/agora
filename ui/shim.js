/* Standalone shell shim: the helpers the chat page used to get from the
   Pantheo admin SPA (api/apiPost/toast/esc/mdLite/...), reimplemented for the
   Agora app. Single-user: the owner token arrives once via ?token= (the
   desktop shell appends it) and is kept in localStorage after that. */

/* ---------- auth ---------- */
let AUTH_ERROR = "";
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
    if (session || AUTH_ERROR) history.replaceState(null, "", location.pathname);
  }
})();
function sessionToken() { return localStorage.getItem("agora_token") || ""; }
function authHeaders() {
  const t = sessionToken();
  return t ? { "Authorization": "Bearer " + t } : {};
}
let CURRENT_USER = { username: "me", owner: true };
function isOwner() { return true; }
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
   when the server offers it; the owner token is always available. */
const AUTH_ERROR_TEXT = {
  no_access: "That Google account isn't allowed on this instance.",
  google_access_denied: "Google sign-in was cancelled.",
  state: "Sign-in expired — try again.",
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
    <div class="auth-brand"><img src="/icon.png" alt="">Agora</div>
    <p id="auth-hint">Admin sign-in: paste this instance's admin token (shown
       in the server log or in <code>config.json</code>).</p>
    <button class="btn google" id="auth-google" style="display:none"
            onclick="location.href='/api/auth/google/start'">
      Continue with Google</button>
    <div id="auth-token-form">
      <input id="auth-token" placeholder="admin token" autocomplete="off">
      <button class="btn primary" onclick="authSubmit()">Sign in as admin</button>
    </div>
    <button class="auth-link" id="auth-token-toggle" style="display:none">
      Sign in as admin</button>
    <p id="auth-error" style="color:#f87171">${esc(errText)}</p>
  </div>`;
  document.body.appendChild(el);
  const input = document.getElementById("auth-token");
  input.focus();
  input.onkeydown = e => { if (e.key === "Enter") authSubmit(); };
  document.getElementById("auth-token-toggle").onclick = () => {
    document.getElementById("auth-token-form").style.display = "";
    document.getElementById("auth-token-toggle").style.display = "none";
    input.focus();
  };
  fetch("/api/auth/config").then(r => r.json()).then(cfg => {
    if (cfg.google && cfg.google.enabled) {
      // Google-first: tuck the token form behind a link.
      document.getElementById("auth-google").style.display = "";
      document.getElementById("auth-token-form").style.display = "none";
      document.getElementById("auth-token-toggle").style.display = "";
      document.getElementById("auth-hint").textContent =
        "Sign in with an allowed Google account.";
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
  t = t.replace(/```\w*\n?([\s\S]*?)```/g,
    (_, code) => stash(`<pre class="md-pre">${code.replace(/\n$/, "")}</pre>`));
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
  x.textContent = "✕";
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
    CURRENT_USER = { username: me.username, owner: true };
    _agoVoiceOK = !!me.voice;   // server has STT/TTS: show the voice controls
  } catch (e) {
    return;   // authGate is showing
  }
  renderAgora().catch(console.error);
  connRefreshBadge().catch(() => {});
}
