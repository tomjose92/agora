/* Agora chat UI: groups, channels, threads, live via the /ws websocket.
   Ported from Pantheo's admin page; talks to the standalone app's /api.
   Voice features (voice notes, speak-aloud, live voice) need OPENAI_API_KEY
   set on the server — the controls hide when it isn't. */

/* ---------- state ---------- */
let _agoGroups = [];            // group payloads {id, name, channels, role}
let _agoAvailAgents = [];       // all agents (for the member picker)
let _agoSel = (() => {          // {g: groupId, c: channelId}
  try { return JSON.parse(localStorage.getItem("agora_sel") || "{}"); }
  catch (e) { return {}; }
})();
let _agoMsgs = [];              // top-level messages of the selected channel
let _agoPins = [];              // pinned thread roots of the selected channel
let _agoPinsOpen = false;       // pinned-threads dropdown expanded
let _agoStars = [];             // my starred messages in the selected channel
let _agoStarsOpen = false;      // starred-messages dropdown expanded
let _agoThreadRoot = null;      // root message when the thread panel is open
let _agoThreadMsgs = [];
let _agoChanAgents = [];        // live member agents of the channel (mention chips)
let _agoTyping = {};            // agent_id -> {name, thread_id}
let _agoProgress = {};          // handle -> {agent_id, agent_name, text, thread_id}
let _agoMembers = null;         // members of the selected group (panel open) or null
let _agoWs = null;
let _agoWsTimer = null;
let _agoWsBackoff = 1000;
let _agoCreating = null;        // "group" | "channel" — inline create row open
let _agoCreatingIn = null;      // group id the inline channel-create row belongs to
let _agoExpanded = (() => {     // expanded group ids (null until first toggle)
  try {
    return JSON.parse(localStorage.getItem("agora_open") || "null");
  } catch (e) { return null; }
})();
let _agoConfirm = null;         // armed destructive action key (two-step delete)
let _agoConfirmTimer = null;
let _agoView = "main";          // mobile drill-down: "side" | "main" | "thread"
let _agoSideCollapsed =         // groups sidebar collapsed to a slim rail
  localStorage.getItem("agora_side") === "collapsed";
let _agoThreadExpanded =        // thread panel widened to fill the main area
  localStorage.getItem("agora_thread") === "expanded";
let _agoMention = null;         // @mention autocomplete: {inputId, items, active, start}
let _agoGroupMembers = {};      // group_id -> members[] cache for the mention list
/* Unread state (mine only): counts drive the sidebar badges, the marker
   snapshot drives the "New" divider and the jump-to-latest bar. Channel
   counts cover top-level messages only; thread replies badge their thread. */
let _agoUnread = {};            // channel_id -> {count, mentions, last_read_id}
let _agoLatestSeen = {};        // channel_id -> highest message id seen live
let _agoDividerAfter = null;    // marker snapshot: "New" renders after this id
let _agoDividerChan = null;     // channel the divider snapshot belongs to
let _agoLandOnDivider = false;  // next draw scrolls to the divider, not the bottom
let _agoReadTimer = null;       // debounce for PUT /read
/* Threads inbox: every thread I participate in, with per-thread unreads. */
let _agoThreads = [];           // rows from GET /api/threads
let _agoInboxOpen = false;      // main pane shows the threads inbox
let _agoGroupPage = false;      // main pane shows the selected group's overview page
let _agoThreadReadTimer = null; // debounce for PUT /threads/:id/read
let _agoThreadsTimer = null;    // debounce for inbox refetches
/* All-unreads view: every unread message across channels and threads. */
let _agoUnreadsOpen = false;    // main pane shows the unreads view
let _agoUnreadItems = [];       // rows from GET /api/unreads
let _agoUnreadsTimer = null;    // debounce for unreads refetches
let _agoUnreadsOnly =           // sidebar shows only unread/mentioned channels
  localStorage.getItem("agora_unreads_only") === "1";
let _agoHiddenOpen = false;     // sidebar "Hidden" section expanded
let _agoEditingChan = false;    // channel header rename/topic editor open
let _agoDrag = null;            // drag-reorder state {type, id, gid}
let _agoAddr = {};              // "talk to" selection: channel or channel:t<id> -> agent ids;
                                // session-level memory so a conversation keeps addressing
                                // the same agents until changed (not persisted anywhere)
let _agoAddrOpen = null;        // composer key whose "talk to" picker popup is open

/* Voice features (voice notes, speak-aloud, live voice) need the server to
   have an OPENAI_API_KEY; /api/me reports it and the controls hide without
   it. Implementation lives in the "voice" sections near the end of the file. */
let _agoVoiceOK = false;

function agoSelGroup() { return _agoGroups.find(g => g.id === _agoSel.g) || null; }
function agoSelChannel() {
  const g = agoSelGroup();
  return g ? (g.channels || []).find(c => c.id === _agoSel.c) || null : null;
}
function agoIsAdmin() {
  const g = agoSelGroup();
  return !!(g && (g.role === "admin" || isOwner()));
}
function agoSlug(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function agoSaveSel() { localStorage.setItem("agora_sel", JSON.stringify(_agoSel)); }

/* Expand/collapse of a group's channel list in the sidebar. */
function agoIsExpanded(gid) {
  return _agoExpanded ? _agoExpanded.includes(gid) : gid === _agoSel.g;
}
function agoSetExpanded(gid, on) {
  const cur = _agoExpanded ? [..._agoExpanded] : (_agoSel.g ? [_agoSel.g] : []);
  _agoExpanded = on ? [...new Set([...cur, gid])] : cur.filter(x => x !== gid);
  localStorage.setItem("agora_open", JSON.stringify(_agoExpanded));
}
function agoToggleGroup(gid) {
  if (agoIsExpanded(gid)) {
    agoSetExpanded(gid, false);
    if (_agoCreating === "channel" && _agoCreatingIn === gid) _agoCreating = null;
    agoDisarm();
    agoDrawSide();
    return;
  }
  agoSetExpanded(gid, true);
  agoDrawSide();
}
function agoErr(msg, e) { toast(`${msg}: ${(e && e.message) || e}`, { variant: "warn" }); }

/* Two-step destructive actions: first click arms ("Sure?"), second within
   5s executes. */
function agoArmed(key) { return _agoConfirm === key; }
function agoArm(key, redraw) {
  _agoConfirm = key;
  clearTimeout(_agoConfirmTimer);
  _agoConfirmTimer = setTimeout(() => { _agoConfirm = null; redraw(); }, 5000);
  redraw();
}
function agoDisarm() { _agoConfirm = null; clearTimeout(_agoConfirmTimer); }

/* Agent avatar: the picture proxied from the agent's home instance
   (/api/agents/{id}/avatar), with the bot icon as fallback when the agent
   has none or the fetch fails. <img> can't send the auth header, so the
   session token rides the URL like agoFileUrl. */
function agoAgentAvatarHTML(agentId, cls) {
  const meta = _agoAvailAgents.find(a => a.id === agentId);
  const av = meta && meta.avatar;
  if (av) {
    const t = sessionToken();
    const src = av + (t ? (av.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t) : "");
    return `<span class="ago-av ${cls || ""} has-avatar"><img src="${esc(src)}" alt=""
      onerror="agoAvatarFallback(this)"></span>`;
  }
  return `<span class="ago-av ${cls || ""}">${icon("bot")}</span>`;
}
function agoAvatarFallback(img) {
  const wrap = img.parentElement;
  wrap.classList.remove("has-avatar");
  wrap.innerHTML = icon("bot");
}

/* Slack-style drill-down on phones. */
function agoSetView(v) {
  _agoView = v;
  const layout = document.getElementById("agora-layout");
  if (!layout) return;
  layout.classList.remove("view-side", "view-main", "view-thread");
  layout.classList.add("view-" + v);
}
function agoBackToGroups() { agoSetView("side"); }

function agoToggleSide() {
  _agoSideCollapsed = !_agoSideCollapsed;
  localStorage.setItem("agora_side", _agoSideCollapsed ? "collapsed" : "open");
  agoApplySideState();
}
function agoApplySideState() {
  const layout = document.getElementById("agora-layout");
  if (layout) layout.classList.toggle("side-collapsed", _agoSideCollapsed);
}

function agoToggleThreadSize() {
  _agoThreadExpanded = !_agoThreadExpanded;
  localStorage.setItem("agora_thread", _agoThreadExpanded ? "expanded" : "open");
  agoApplyThreadState();
  agoDrawThread();
}
function agoApplyThreadState() {
  const layout = document.getElementById("agora-layout");
  if (layout) layout.classList.toggle("thread-expanded", !!_agoThreadRoot && _agoThreadExpanded);
}

/* ---------- load ---------- */
async function renderAgora() {
  agoConnectWs();
  if (!document.getElementById("agora-layout")) {
    document.getElementById("content").innerHTML = `
      <div class="agora-layout" id="agora-layout">
        <div class="agora-side" id="agora-side"></div>
        <div class="agora-main" id="agora-main"></div>
        <div class="agora-thread" id="agora-thread" style="display:none"></div>
        <div class="agora-members-pane" id="agora-members-pane" style="display:none"></div>
      </div>`;
  }
  agoApplySideState();
  const [, agents] = await Promise.all([
    agoLoadGroups(),
    api("/api/agents").catch(() => null),
    agoLoadThreads(),
  ]);
  if (agents) _agoAvailAgents = agents.agents || [];
  agoSetView(_agoThreadRoot ? "thread" : (agoSelChannel() ? "main" : "side"));
  agoDrawSide();
  await agoLoadChannel();
}

async function agoLoadGroups() {
  try {
    const data = await api("/api/groups");
    _agoGroups = data.groups || [];
  } catch (e) {
    document.getElementById("agora-side").innerHTML =
      `<div class="dim" style="padding:12px">Couldn't load groups: ${esc(e.message)}</div>`;
    _agoGroups = [];
    return;
  }
  _agoUnread = {};
  for (const g of _agoGroups) {
    for (const c of g.channels || []) {
      _agoUnread[c.id] = {
        count: c.unread || 0,
        mentions: c.mentions || 0,
        last_read_id: c.last_read_id || 0,
      };
    }
  }
  if (_agoExpanded) {
    _agoExpanded = _agoExpanded.filter(id => _agoGroups.some(g => g.id === id));
  }
  if (!agoSelGroup()) {
    const first = _agoGroups.find(g => !g.hidden) || _agoGroups[0] || null;
    _agoSel.g = first ? first.id : null;
    _agoSel.c = null;
  }
  const g = agoSelGroup();
  // On the group overview page no channel is selected on purpose.
  if (g && !agoSelChannel() && !_agoGroupPage) {
    const firstChan = (g.channels || []).find(c => !c.hidden) || (g.channels || [])[0] || null;
    _agoSel.c = firstChan ? firstChan.id : null;
  }
  agoSaveSel();
}

async function agoLoadChannel() {
  const channel = agoSelChannel();
  if (!channel) { agoDrawMain(); agoDrawThread(); agoDrawMembers(); return; }
  if (_agoDividerChan !== channel.id) {
    const u = _agoUnread[channel.id];
    _agoDividerAfter = u && u.count > 0 ? u.last_read_id : null;
    _agoDividerChan = channel.id;
    _agoLandOnDivider = _agoDividerAfter != null;
  }
  try {
    const [msgs, agents, pins, stars, activity] = await Promise.all([
      api(`/api/channels/${encodeURIComponent(channel.id)}/messages?limit=100`),
      api(`/api/channels/${encodeURIComponent(channel.id)}/agents`),
      api(`/api/channels/${encodeURIComponent(channel.id)}/pins`).catch(() => null),
      api(`/api/channels/${encodeURIComponent(channel.id)}/stars`).catch(() => null),
      api(`/api/channels/${encodeURIComponent(channel.id)}/activity`).catch(() => null),
    ]);
    _agoMsgs = msgs.messages || [];
    _agoChanAgents = agents.agents || [];
    _agoPins = (pins && pins.pins) || [];
    _agoStars = (stars && stars.stars) || [];
    agoSeedActivity(activity);
    const maxId = _agoMsgs.reduce((n, m) => Math.max(n, m.id), 0);
    _agoLatestSeen[channel.id] = Math.max(_agoLatestSeen[channel.id] || 0, maxId);
  } catch (e) {
    _agoMsgs = [];
    _agoChanAgents = [];
    _agoPins = [];
    _agoStars = [];
    agoSeedActivity(null);
  }
  if (_agoThreadRoot && _agoThreadRoot.channel_id !== channel.id) {
    _agoThreadRoot = null;
    _agoThreadMsgs = [];
  }
  agoDrawMain();
  agoDrawThread();
}

/* Replace typing/progress state with the server's current snapshot. */
function agoSeedActivity(activity) {
  _agoTyping = {};
  _agoProgress = {};
  for (const t of (activity && activity.typing) || []) {
    _agoTyping[t.agent_id] = { name: t.agent_name, thread_id: t.thread_id };
  }
  for (const p of (activity && activity.progress) || []) {
    _agoProgress[p.handle] = {
      agent_id: p.agent_id, agent_name: p.agent_name,
      text: p.text, thread_id: p.thread_id,
    };
  }
}

/* ---------- unread state ---------- */
function agoUnreadCount(cid) { const u = _agoUnread[cid]; return u ? u.count : 0; }
function agoMentionCount(cid) { const u = _agoUnread[cid]; return u ? (u.mentions || 0) : 0; }
/* Hidden channels don't feed the badges — out of sight, out of mind. */
function agoGroupUnread(g) {
  return (g.channels || []).filter(c => !c.hidden)
    .reduce((n, c) => n + agoUnreadCount(c.id), 0);
}
function agoGroupMentions(g) {
  return (g.channels || []).filter(c => !c.hidden)
    .reduce((n, c) => n + agoMentionCount(c.id), 0);
}
/* Slack/Discord-style badges: red only when @you; plain traffic is muted. */
function agoBadgeHTML(n, mentions) {
  if (mentions > 0) {
    return `<span class="ago-unread-badge mention" title="${mentions} mention${mentions === 1 ? "" : "s"}">@ ${mentions > 99 ? "99+" : mentions}</span>`;
  }
  return n > 0 ? `<span class="ago-unread-badge">${n > 99 ? "99+" : n}</span>` : "";
}
/* Does this message @mention me? Mirrors the server's mention_tokens. */
function agoMentionsMe(text) {
  if (!CURRENT_USER || !CURRENT_USER.username) return false;
  const me = CURRENT_USER.username.toLowerCase();
  const re = /(^|[\s(>])@([A-Za-z0-9][\w.-]*)/g;
  let m;
  while ((m = re.exec(text || ""))) {
    if (m[2].toLowerCase() === me) return true;
  }
  return false;
}
function agoAtBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
}

function agoOnScroll() {
  const box = document.getElementById("ago-log");
  if (box && agoAtBottom(box)) agoMaybeMarkRead();
}

function agoMaybeMarkRead() {
  const channel = agoSelChannel();
  const box = document.getElementById("ago-log");
  if (!channel || !box) return;
  // Seen = actually looking: visible AND focused. An unfocused window keeps
  // messages unread, which is also what drives the app's notifications.
  if (document.visibilityState !== "visible" || !document.hasFocus()) return;
  if (!agoAtBottom(box)) return;
  const u = _agoUnread[channel.id] || (_agoUnread[channel.id] = { count: 0, last_read_id: 0 });
  if (u.count <= 0 && (_agoLatestSeen[channel.id] || 0) <= u.last_read_id) return;
  clearTimeout(_agoReadTimer);
  _agoReadTimer = setTimeout(() => { agoMarkReadNow().catch(() => {}); }, 400);
}

async function agoMarkReadNow() {
  const channel = agoSelChannel();
  if (!channel) return;
  clearTimeout(_agoReadTimer);
  try {
    const resp = await apiPost(
      `/api/channels/${encodeURIComponent(channel.id)}/read`, {}, "PUT");
    agoApplyRead(channel.id, resp.last_read_id || 0);
  } catch (e) { /* transient — the next scroll/visibility check retries */ }
}

function agoApplyRead(cid, lastId) {
  const u = _agoUnread[cid] || (_agoUnread[cid] = { count: 0, mentions: 0, last_read_id: 0 });
  if (lastId < u.last_read_id) return;   // stale ack from a slow tab
  u.last_read_id = lastId;
  u.count = 0;
  u.mentions = 0;
  agoDrawSide();
  agoDrawUnreadBar();
  agoScheduleUnreadsRefresh();
}

function agoJumpToLatest() {
  const box = document.getElementById("ago-log");
  if (!box) return;
  box.scrollTop = box.scrollHeight;
  agoMaybeMarkRead();
}

function agoDrawUnreadBar() {
  const bar = document.getElementById("ago-unread-bar");
  const channel = agoSelChannel();
  if (!bar) return;
  const n = channel ? agoUnreadCount(channel.id) : 0;
  if (!n) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "";
  bar.innerHTML = `
    <span class="ago-unread-n">${n} new message${n === 1 ? "" : "s"}</span>
    <button class="lnk" onclick="agoJumpToLatest()">Jump to latest ${icon("arrow-down")}</button>
    <button class="lnk dim" onclick="agoMarkReadNow()">Mark as read</button>`;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  agoMaybeMarkRead();
  agoMaybeMarkThreadRead();
});
// Coming back to the window acks whatever is on screen (the counterpart of
// the hasFocus() guard above).
window.addEventListener("focus", () => { agoMaybeMarkRead(); agoMaybeMarkThreadRead(); });

/* ---------- threads inbox + per-thread unreads ---------- */
async function agoLoadThreads() {
  try {
    const data = await api("/api/threads?limit=100");
    _agoThreads = data.threads || [];
  } catch (e) { /* keep whatever we had */ }
}

/* Refetch the inbox soon (joining a thread / a thread we don't have yet). */
function agoScheduleThreadsRefresh() {
  clearTimeout(_agoThreadsTimer);
  _agoThreadsTimer = setTimeout(async () => {
    await agoLoadThreads();
    agoDrawSide();
    if (_agoInboxOpen) agoDrawMain();
  }, 500);
}

function agoThreadUnreadTotal() {
  return _agoThreads.reduce((n, t) => n + (t.unread || 0), 0);
}

/* Threads of a channel worth surfacing in the sidebar: unread, or active in
   the last 48h. Capped so a busy channel doesn't swallow the sidebar. */
function agoChannelThreads(cid) {
  const cutoff = Date.now() / 1000 - 48 * 3600;
  return _agoThreads
    .filter(t => t.channel_id === cid
      && ((t.unread || 0) > 0 || (t.last_reply_ts || 0) > cutoff))
    .slice(0, 5);
}

/* A live thread reply landed: update inbox state and badges. */
function agoBumpThreadUnread(m, seenNow) {
  const t = _agoThreads.find(x => x.root && x.root.id === m.thread_id);
  if (t) {
    t.reply_count = (t.reply_count || 0) + 1;
    t.last_reply_id = Math.max(t.last_reply_id || 0, m.id);
    t.last_reply_ts = m.ts || t.last_reply_ts;
    if (!seenNow) t.unread = (t.unread || 0) + 1;
    _agoThreads.sort((a, b) => (b.last_reply_id || 0) - (a.last_reply_id || 0));
    agoDrawSide();
    if (_agoInboxOpen) agoDrawMain();
  } else {
    // A thread we participate in but don't have yet (e.g. reply under our
    // old root beyond the loaded window) — refetch to find out.
    agoScheduleThreadsRefresh();
  }
  if (seenNow) agoMaybeMarkThreadRead();
}

function agoOnThreadScroll() {
  const box = document.getElementById("ago-thread-log");
  if (box && agoAtBottom(box)) agoMaybeMarkThreadRead();
}

function agoMaybeMarkThreadRead() {
  if (!_agoThreadRoot) return;
  const box = document.getElementById("ago-thread-log");
  if (!box) return;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return;
  if (!agoAtBottom(box)) return;
  const t = _agoThreads.find(x => x.root && x.root.id === _agoThreadRoot.id);
  const latest = _agoThreadMsgs.reduce((n, m) => Math.max(n, m.id), 0);
  if (t && (t.unread || 0) <= 0 && latest <= (t.last_read_id || 0)) return;
  if (!t && !_agoThreadMsgs.length) return;
  clearTimeout(_agoThreadReadTimer);
  _agoThreadReadTimer = setTimeout(() => { agoMarkThreadReadNow().catch(() => {}); }, 400);
}

async function agoMarkThreadReadNow() {
  if (!_agoThreadRoot) return;
  const rootId = _agoThreadRoot.id;
  clearTimeout(_agoThreadReadTimer);
  try {
    const resp = await apiPost(`/api/threads/${rootId}/read`, {}, "PUT");
    agoApplyThreadRead(rootId, resp.last_read_id || 0);
  } catch (e) { /* transient — retried on next scroll/focus */ }
}

function agoApplyThreadRead(rootId, lastId) {
  const t = _agoThreads.find(x => x.root && x.root.id === rootId);
  if (!t) return;
  if (lastId < (t.last_read_id || 0)) return;
  t.last_read_id = lastId;
  t.unread = 0;
  agoDrawSide();
  if (_agoInboxOpen) agoDrawMain();
  agoScheduleUnreadsRefresh();
}

/* Navigate to a thread from the inbox or a sidebar thread row — possibly in
   a different channel than the one on screen. */
async function agoGoToThread(gid, cid, rootId) {
  _agoInboxOpen = false;
  _agoUnreadsOpen = false;
  _agoGroupPage = false;
  if (_agoSel.c !== cid || _agoSel.g !== gid) {
    agoSetExpanded(gid, true);
    _agoFiles = {};
    _agoSel.g = gid; _agoSel.c = cid;
    _agoThreadRoot = null; _agoThreadMsgs = []; _agoMembers = null;
    _agoPins = []; _agoPinsOpen = false;
    _agoStars = []; _agoStarsOpen = false;
    agoSaveSel();
    _agoCreating = null;
    agoDisarm();
    agoDrawSide();
    await agoLoadChannel();
  } else if (!agoSelChannel()) {
    return;
  } else {
    agoDrawSide();
    agoDrawMain();
  }
  await agoOpenThread(rootId);
}

function agoOpenInbox() {
  _agoInboxOpen = true;
  _agoUnreadsOpen = false;
  _agoGroupPage = false;
  _agoThreadRoot = null; _agoThreadMsgs = [];
  _agoMembers = null;
  agoSetView("main");
  agoDrawSide();
  agoDrawMain();
  agoDrawThread();
  agoDrawMembers();
}

function agoThreadRowHTML(t) {
  const root = t.root || {};
  const badge = agoBadgeHTML(t.unread || 0, 0);
  const when = fmtTs(t.last_reply_ts || root.ts);
  const g = _agoGroups.find(x => x.id === t.group_id);
  const armed = agoArmed("thr:" + root.id);
  const rename = `<button class="ago-x" title="Rename this thread"
       onclick="event.stopPropagation(); agoRenameThread(${root.id})">${icon("pencil")}</button>`;
  const del = (g && g.role === "admin") || isOwner()
    ? `<button class="ago-x ${armed ? "armed" : ""}"
         title="${armed ? "Click again to remove this thread" : "Remove from Threads (messages stay in the channel)"}"
         onclick="event.stopPropagation(); agoHideThread(${root.id})">${armed ? "Sure?" : icon("x")}</button>`
    : "";
  return `
    <div class="ago-inbox-row ${t.unread ? "unread" : ""}"
         onclick="agoGoToThread('${esc(t.group_id)}','${esc(t.channel_id)}',${root.id})">
      <div class="ago-inbox-top">
        <span class="chan"><span class="hash">#</span>${esc(t.channel_name)}<span class="grp"> · ${esc(t.group_name)}</span></span>
        <span class="ts">${esc(when)}</span>
        ${rename}
        ${del}
      </div>
      <div class="ago-inbox-main">
        <span class="author">${esc(agoAuthorLabel(root))}</span>
        <span class="snippet">${esc(agoPinSnippet(root))}</span>
      </div>
      <div class="ago-inbox-foot">
        <span class="replies">${t.reply_count} repl${t.reply_count === 1 ? "y" : "ies"}</span>
        ${badge}
      </div>
    </div>`;
}

function agoDrawInbox(box) {
  const rows = _agoThreads.map(agoThreadRowHTML).join("");
  box.innerHTML = `
    <div class="ago-head">
      <button class="btn sm ago-back" title="Back to groups" onclick="agoBackToGroups()">${icon("chevron-left")}</button>
      <div class="ago-head-text">
        <span class="ago-chan-name">${icon("messages-square")} Threads</span>
        <span class="dim">conversations you're part of</span>
      </div>
      <div class="ago-head-actions">
        <button class="btn sm" title="Refresh"
          onclick="agoScheduleThreadsRefresh()">${icon("refresh-cw")}</button>
      </div>
    </div>
    <div class="ago-log ago-inbox-list">${rows
      || `<div class="empty"><div class="glyph">${icon("messages-square")}</div><div>No threads yet</div>
          <div class="hint">Threads you start or reply in show up here, with unread counts as replies land.</div></div>`}
    </div>`;
}

/* ---------- all-unreads view (channels + threads in one pane) ---------- */
async function agoLoadUnreads() {
  try {
    const data = await api("/api/unreads?limit=200");
    _agoUnreadItems = data.unreads || [];
  } catch (e) { /* keep whatever we had */ }
}

function agoOpenUnreads() {
  _agoUnreadsOpen = true;
  _agoInboxOpen = false;
  _agoGroupPage = false;
  _agoThreadRoot = null; _agoThreadMsgs = [];
  _agoMembers = null;
  agoSetView("main");
  agoDrawSide();
  agoDrawMain();
  agoDrawThread();
  agoDrawMembers();
  agoLoadUnreads().then(() => { if (_agoUnreadsOpen) { agoDrawMain(); } });
}

/* Refetch soon while the view is open (new traffic or read acks landed). */
function agoScheduleUnreadsRefresh() {
  if (!_agoUnreadsOpen) return;
  clearTimeout(_agoUnreadsTimer);
  _agoUnreadsTimer = setTimeout(async () => {
    await agoLoadUnreads();
    if (_agoUnreadsOpen) agoDrawMain();
  }, 500);
}

function agoUnreadSnippet(m) {
  const text = (m.text || "").replace(/\s+/g, " ").trim();
  return text || "(attachment)";
}

/* Label for a thread bucket: the root's alias, else its first line. */
function agoUnreadThreadLabel(m) {
  const alias = (m.root_alias || "").trim();
  if (alias) return alias;
  return (m.root_text || "").split("\n")[0].slice(0, 140) || "(thread)";
}

function agoDrawUnreads(box) {
  // Bucket the flat newest-first list by conversation — a channel's top
  // level or one thread — so each card reads like the room it came from.
  const buckets = new Map();
  for (const m of _agoUnreadItems) {
    const key = m.thread_id != null ? "t:" + m.thread_id : "c:" + m.channel_id;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const cards = [...buckets.values()].map(items => {
    const first = items[0];
    const isThread = first.thread_id != null;
    const title = isThread
      ? `<span class="tico">${icon("corner-down-right")}</span> ${esc(agoUnreadThreadLabel(first))}
         <span class="grp"> · #${esc(first.channel_name)} · ${esc(first.group_name)}</span>`
      : `<span class="hash">#</span>${esc(first.channel_name)}<span class="grp"> · ${esc(first.group_name)}</span>`;
    const open = isThread
      ? `agoGoToThread('${esc(first.group_id)}','${esc(first.channel_id)}',${first.thread_id})`
      : `agoSelectChannel('${esc(first.group_id)}','${esc(first.channel_id)}')`;
    const msgs = items.slice().reverse().map(m => `
      <div class="ago-unreads-msg">
        <span class="author">${esc(agoAuthorLabel(m))}</span>
        <span class="snippet">${esc(agoUnreadSnippet(m))}</span>
        <span class="ts">${esc(fmtTs(m.ts))}</span>
      </div>`).join("");
    return `
      <div class="ago-inbox-row unread" onclick="${open}"
           title="Open ${isThread ? "this thread" : "#" + esc(first.channel_name)}">
        <div class="ago-inbox-top">
          <span class="chan">${title}</span>
          ${agoBadgeHTML(items.length, 0)}
        </div>
        ${msgs}
      </div>`;
  }).join("");
  box.innerHTML = `
    <div class="ago-head">
      <button class="btn sm ago-back" title="Back to groups" onclick="agoBackToGroups()">${icon("chevron-left")}</button>
      <div class="ago-head-text">
        <span class="ago-chan-name">${icon("circle-dot")} Unreads</span>
        <span class="dim">every unread message across channels and threads</span>
      </div>
      <div class="ago-head-actions">
        <button class="btn sm" title="Refresh"
          onclick="agoLoadUnreads().then(agoDrawMain)">${icon("refresh-cw")}</button>
      </div>
    </div>
    <div class="ago-log ago-inbox-list">${cards
      || `<div class="empty"><div class="glyph">${icon("circle-dot")}</div><div>All caught up</div>
          <div class="hint">Unread messages from channels and the threads you're part of collect here.</div></div>`}
    </div>`;
}

/* ---------- sidebar (groups + channels) ---------- */
function agoToggleUnreadsOnly() {
  _agoUnreadsOnly = !_agoUnreadsOnly;
  localStorage.setItem("agora_unreads_only", _agoUnreadsOnly ? "1" : "0");
  agoDrawSide();
}

function agoDrawSide() {
  const box = document.getElementById("agora-side");
  if (!box) return;
  const groupRows = _agoGroups.filter(g => !g.hidden).map(g => {
    const open = agoIsExpanded(g.id);
    const sel = g.id === _agoSel.g;
    const groupUnread = agoGroupUnread(g);
    const groupMentions = agoGroupMentions(g);
    const channels = open ? (g.channels || []).filter(c => !c.hidden).map(c => {
      const armed = agoArmed("chan:" + c.id);
      const unread = agoUnreadCount(c.id);
      const mentions = agoMentionCount(c.id);
      const threads = agoChannelThreads(c.id);
      const threadUnread = threads.reduce((n, t) => n + (t.unread || 0), 0);
      const active = sel && c.id === _agoSel.c && !_agoInboxOpen && !_agoGroupPage && !_agoUnreadsOpen;
      // Unreads-only mode: keep unread/mentioned channels, live threads, and
      // whatever is selected so nothing on screen becomes unreachable.
      if (_agoUnreadsOnly && !unread && !mentions && !threadUnread && !active) return "";
      const del = (g.role === "admin" || isOwner())
        ? `<button class="ago-x hide" title="Hide #${esc(c.name)} from the sidebar"
             onclick="event.stopPropagation(); agoSetChannelHidden('${esc(g.id)}','${esc(c.id)}',true)">${icon("eye-off")}</button>
           <button class="ago-x ${armed ? "armed" : ""}" title="${armed ? "Click again to delete #" + esc(c.name) : "Delete channel"}"
             onclick="event.stopPropagation(); agoDeleteChannel('${esc(g.id)}','${esc(c.id)}')">${armed ? "Sure?" : icon("x")}</button>`
        : "";
      const threadRows = threads
        .filter(t => !_agoUnreadsOnly || (t.unread || 0) > 0)
        .map(t => {
          const tArmed = agoArmed("thr:" + t.root.id);
          const tRename = `<button class="ago-x" title="Rename this thread"
                 onclick="event.stopPropagation(); agoRenameThread(${t.root.id})">${icon("pencil")}</button>`;
          const tDel = (g.role === "admin" || isOwner())
            ? `<button class="ago-x ${tArmed ? "armed" : ""}"
                 title="${tArmed ? "Click again to remove this thread" : "Remove thread from the sidebar (messages stay in the channel)"}"
                 onclick="event.stopPropagation(); agoHideThread(${t.root.id})">${tArmed ? "Sure?" : icon("x")}</button>`
            : "";
          return `
        <div class="ago-side-thread ${t.unread ? "unread" : ""}"
             title="${esc(agoPinSnippet(t.root || {}))}"
             onclick="event.stopPropagation(); agoGoToThread('${esc(g.id)}','${esc(c.id)}',${t.root.id})">
          <span class="tico">${icon("corner-down-right")}</span>
          <span class="nm">${esc(agoPinSnippet(t.root || {}))}</span>
          ${agoBadgeHTML(t.unread || 0, 0)}
          ${tRename}
          ${tDel}
        </div>`;
        }).join("");
      return `
      <div class="ago-chan ${active ? "active" : ""} ${unread || mentions ? "unread" : ""}"
           draggable="true"
           ondragstart="agoDragStart(event,'chan','${esc(c.id)}','${esc(g.id)}')"
           ondragover="agoDragOverRow(event,'chan','${esc(c.id)}','${esc(g.id)}')"
           ondrop="agoDropRow(event,'chan','${esc(c.id)}','${esc(g.id)}')"
           onclick="agoSelectChannel('${esc(g.id)}','${esc(c.id)}')">
        <span class="hash">#</span><span class="nm">${esc(c.name)}</span>
        ${agoBadgeHTML(unread, mentions)}
        ${del}
      </div>${threadRows}`;
    }).join("") : "";
    const addChan = open && !_agoUnreadsOnly && (g.role === "admin" || isOwner())
      ? (_agoCreating === "channel" && _agoCreatingIn === g.id
        ? `<div class="ago-create"><input id="ago-new-channel" placeholder="channel name"
             onkeydown="if(event.key==='Enter')agoCreateChannel();if(event.key==='Escape')agoCancelCreate()">
           <button class="btn sm" onclick="agoCreateChannel()">Add</button></div>`
        : `<button class="ago-add" onclick="agoOpenCreate('channel','${esc(g.id)}')">+ channel</button>`)
      : "";
    return `<div class="ago-group ${open ? "open" : ""} ${sel ? "sel" : ""}">
      <div class="ago-group-head ${groupUnread || groupMentions ? "unread" : ""}"
           draggable="true"
           ondragstart="agoDragStart(event,'group','${esc(g.id)}')"
           ondragover="agoDragOverRow(event,'group','${esc(g.id)}')"
           ondrop="agoDropRow(event,'group','${esc(g.id)}')"
           onclick="agoOpenGroupPage('${esc(g.id)}')"
           title="Open ${esc(g.name)}">
        <span class="ago-caret ${open ? "open" : ""}" title="${open ? "Collapse" : "Expand"} ${esc(g.name)}"
              onclick="event.stopPropagation(); agoToggleGroup('${esc(g.id)}')">${icon("chevron-right")}</span>
        <span class="ago-group-title">
          <span class="nm">${esc(g.name)}</span>
        </span>
        ${open ? "" : agoBadgeHTML(groupUnread, groupMentions)}
        <span class="role">${esc(g.role || "")}</span>
      </div>
      ${channels}${addChan}
    </div>`;
  }).join("");
  const addGroup = _agoCreating === "group"
    ? `<div class="ago-create"><input id="ago-new-group" placeholder="group name"
         onkeydown="if(event.key==='Enter')agoCreateGroup();if(event.key==='Escape')agoCancelCreate()">
       <button class="btn sm" onclick="agoCreateGroup()">Add</button></div>`
    : `<button class="ago-add" onclick="agoOpenCreate('group')">+ New group</button>`;
  // Hidden groups/channels live in a tucked-away section so they stay
  // reachable (and un-hideable) without cluttering the main list.
  const hiddenGroups = _agoGroups.filter(g => g.hidden);
  const hiddenChans = _agoGroups.filter(g => !g.hidden)
    .flatMap(g => (g.channels || []).filter(c => c.hidden).map(c => ({ g, c })));
  const hiddenCount = hiddenGroups.length + hiddenChans.length;
  const hiddenRows = _agoHiddenOpen ? [
    ...hiddenGroups.map(g => `
      <div class="ago-hidden-row" title="Open ${esc(g.name)}"
           onclick="agoOpenGroupPage('${esc(g.id)}')">
        <span class="nm">${esc(g.name)}</span>
        <button class="ago-x show" title="Show ${esc(g.name)} in the sidebar"
          onclick="event.stopPropagation(); agoSetGroupHidden('${esc(g.id)}',false)">${icon("eye")}</button>
      </div>`),
    ...hiddenChans.map(({ g, c }) => `
      <div class="ago-hidden-row" title="Open #${esc(c.name)}"
           onclick="agoSelectChannel('${esc(g.id)}','${esc(c.id)}')">
        <span class="nm"><span class="hash">#</span>${esc(c.name)}<span class="grp"> · ${esc(g.name)}</span></span>
        <button class="ago-x show" title="Show #${esc(c.name)} in the sidebar"
          onclick="event.stopPropagation(); agoSetChannelHidden('${esc(g.id)}','${esc(c.id)}',false)">${icon("eye")}</button>
      </div>`),
  ].join("") : "";
  const hiddenSection = hiddenCount ? `
    <div class="ago-hidden">
      <button class="ago-hidden-toggle" onclick="agoToggleHiddenSection()"
        title="${_agoHiddenOpen ? "Collapse" : "Expand"} hidden groups & channels">
        <span class="ago-caret ${_agoHiddenOpen ? "open" : ""}">${icon("chevron-right")}</span>
        ${icon("eye-off")} Hidden <span class="cnt">${hiddenCount}</span>
      </button>
      ${hiddenRows}
    </div>` : "";
  const anyUnread = _agoGroups.some(g => agoGroupUnread(g) > 0) || agoThreadUnreadTotal() > 0;
  const anyMention = _agoGroups.some(g => agoGroupMentions(g) > 0);
  const threadTotal = agoThreadUnreadTotal();
  const chanTotal = _agoGroups.filter(g => !g.hidden).reduce((n, g) => n + agoGroupUnread(g), 0);
  const mentionTotal = _agoGroups.filter(g => !g.hidden).reduce((n, g) => n + agoGroupMentions(g), 0);
  const unreadTotal = chanTotal + threadTotal;
  box.innerHTML = `<div class="side-title"><span>Groups</span>
      <span class="side-title-actions">
        <button class="ago-side-toggle search" title="Search (${AGO_SEARCH_KEY})"
          onclick="agoSearchShow()">${icon("search")}</button>
        <button class="ago-side-toggle filter ${_agoUnreadsOnly ? "on" : ""}"
          title="${_agoUnreadsOnly ? "Show all channels" : "Show unreads only"}"
          onclick="agoToggleUnreadsOnly()">${icon("circle-dot")}</button>
        <button class="ago-side-toggle collapse" title="Collapse groups" onclick="agoToggleSide()">${icon("chevrons-left")}</button>
      </span></div>
    <button class="ago-side-toggle expand" title="Show groups" onclick="agoToggleSide()">${icon("chevrons-right")}</button>
    ${anyUnread ? `<span class="ago-side-dot ${anyMention ? "mention" : ""}" title="Unread messages"></span>` : ""}
    <div class="ago-inbox-item ${_agoUnreadsOpen ? "active" : ""} ${unreadTotal || mentionTotal ? "unread" : ""}"
         onclick="agoOpenUnreads()" title="All unread messages across channels and threads">
      <span class="tico">${icon("circle-dot")}</span><span class="nm">Unreads</span>
      ${agoBadgeHTML(unreadTotal, mentionTotal)}
    </div>
    <div class="ago-inbox-item ${_agoInboxOpen ? "active" : ""} ${threadTotal ? "unread" : ""}"
         onclick="agoOpenInbox()">
      <span class="tico">${icon("messages-square")}</span><span class="nm">Threads</span>
      ${agoBadgeHTML(threadTotal, 0)}
    </div>
    <div class="ago-groups">${groupRows ||
      '<div class="dim" style="padding:10px 12px;font-size:12px">No groups yet — create one to start chatting.</div>'}</div>
    ${hiddenSection}
    <div class="ago-side-foot">${addGroup}</div>`;
  const input = document.getElementById("ago-new-group") || document.getElementById("ago-new-channel");
  if (input) input.focus();
}

/* ---------- drag-to-reorder (desktop) ---------- */
function agoDragStart(ev, type, id, gid) {
  _agoDrag = { type, id, gid: gid || null };
  ev.dataTransfer.effectAllowed = "move";
  try { ev.dataTransfer.setData("text/plain", id); } catch (e) {}
}
function agoDragOverRow(ev, type, id, gid) {
  if (!_agoDrag || _agoDrag.type !== type) return;
  if (type === "chan" && _agoDrag.gid !== (gid || null)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "move";
}
async function agoDropRow(ev, type, id, gid) {
  ev.preventDefault();
  const drag = _agoDrag;
  _agoDrag = null;
  if (!drag || drag.type !== type || drag.id === id) return;
  let path, ids;
  if (type === "chan") {
    if (drag.gid !== (gid || null)) return;
    const g = _agoGroups.find(x => x.id === gid);
    if (!g) return;
    ids = (g.channels || []).map(c => c.id).filter(x => x !== drag.id);
    path = `/api/groups/${encodeURIComponent(gid)}/channels/order`;
  } else {
    ids = _agoGroups.map(x => x.id).filter(x => x !== drag.id);
    path = "/api/groups/order";
  }
  const at = ids.indexOf(id);
  ids.splice(at < 0 ? ids.length : at, 0, drag.id);  // dropped-on row shifts down
  try {
    await apiPost(path, { ids }, "PUT");
    await agoLoadGroups();
    agoDrawSide();
  } catch (e) { agoErr("Couldn't reorder", e); }
}

/* Group overview page: clicking a group name in the sidebar opens it in the
   main pane — channels, description, and (for admins) the delete action. */
function agoOpenGroupPage(gid) {
  agoSetExpanded(gid, true);
  _agoInboxOpen = false;
  _agoUnreadsOpen = false;
  _agoGroupPage = true;
  if (_agoSel.g !== gid) {
    agoVoiceCancel();   // a recording is tied to the channel it started in
    agoLiveStop();      // so is a live voice session
    agoSpeakStop();     // don't keep reading the previous channel's replies
    _agoSel.g = gid;
    _agoSel.c = null;
    agoSaveSel();
  }
  _agoThreadRoot = null; _agoThreadMsgs = []; _agoMembers = null;
  _agoPins = []; _agoPinsOpen = false;
  _agoStars = []; _agoStarsOpen = false;
  _agoEditingChan = false;
  _agoCreating = null;
  agoDisarm();
  agoSetView("main");   // phones: opening a group drills into its page
  agoDrawSide();
  agoDrawMain();
  agoDrawThread();
  agoDrawMembers();
}
function agoSelectChannel(gid, cid) {
  agoSetExpanded(gid, true);
  _agoInboxOpen = false;
  _agoUnreadsOpen = false;
  _agoGroupPage = false;
  if (_agoSel.c !== cid || _agoSel.g !== gid) {
    agoVoiceCancel();   // a recording is tied to the channel it started in
    agoLiveStop();      // so is a live voice session
    agoSpeakStop();     // don't keep reading the previous channel's replies
    _agoFiles = {};     // pending attachments belong to the previous channel
    _agoAddrOpen = null;   // the "talk to" selection itself is per channel and persists
    _agoSel.g = gid; _agoSel.c = cid;
    _agoThreadRoot = null; _agoThreadMsgs = []; _agoMembers = null;
    _agoPins = []; _agoPinsOpen = false;
    _agoStars = []; _agoStarsOpen = false;
    _agoEditingChan = false;
    agoSaveSel();
    _agoCreating = null;
    agoDisarm();
  }
  agoSetView("main");   // phones: picking a channel drills into it
  agoDrawSide();
  agoLoadChannel().catch(console.error);
}
function agoOpenCreate(kind, gid) { _agoCreating = kind; _agoCreatingIn = gid || null; agoDrawSide(); }
function agoCancelCreate() { _agoCreating = null; _agoCreatingIn = null; agoDrawSide(); }
async function agoCreateGroup() {
  const input = document.getElementById("ago-new-group");
  const name = (input && input.value || "").trim();
  if (!name) return;
  try {
    const group = await apiPost("/api/groups", { name });
    _agoCreating = null;
    await agoLoadGroups();
    agoOpenGroupPage(group.id);
  } catch (e) { agoErr("Couldn't create group", e); }
}
async function agoCreateChannel() {
  const input = document.getElementById("ago-new-channel");
  const name = (input && input.value || "").trim();
  const gid = _agoCreatingIn || _agoSel.g;
  if (!name || !gid) return;
  try {
    const channel = await apiPost(`/api/groups/${encodeURIComponent(gid)}/channels`, { name });
    _agoCreating = null;
    _agoCreatingIn = null;
    await agoLoadGroups();
    agoSelectChannel(gid, channel.id);
  } catch (e) { agoErr("Couldn't create channel", e); }
}
async function agoDeleteChannel(gid, cid) {
  if (!agoArmed("chan:" + cid)) { agoArm("chan:" + cid, agoDrawSide); return; }
  agoDisarm();
  try {
    await apiPost(`/api/groups/${encodeURIComponent(gid)}/channels/${encodeURIComponent(cid)}`, {}, "DELETE");
    if (_agoSel.c === cid) _agoSel.c = null;
    await agoLoadGroups();
    agoDrawSide();
    agoLoadChannel().catch(console.error);
    toast("Channel deleted", { variant: "ok" });
  } catch (e) { agoErr("Delete failed", e); agoDrawSide(); }
}
async function agoDeleteGroup(gid) {
  // Lives on the group overview page — arm/confirm redraws the main pane.
  const g = _agoGroups.find(x => x.id === gid);
  if (!g) return;
  if (!agoArmed("group:" + g.id)) { agoArm("group:" + g.id, agoDrawMain); return; }
  agoDisarm();
  try {
    await apiPost(`/api/groups/${encodeURIComponent(g.id)}`, {}, "DELETE");
    if (_agoSel.g === g.id) { _agoSel = {}; _agoMembers = null; agoSaveSel(); }
    _agoGroupPage = false;
    await agoLoadGroups();
    agoDrawSide();
    agoLoadChannel().catch(console.error);
    toast(`Group "${g.name}" deleted`, { variant: "ok" });
  } catch (e) { agoErr("Delete failed", e); agoDrawMain(); }
}

/* ---------- hide / show (sidebar tidying, nothing is deleted) ---------- */
function agoToggleHiddenSection() { _agoHiddenOpen = !_agoHiddenOpen; agoDrawSide(); }

async function agoSetGroupHidden(gid, hidden) {
  const g = _agoGroups.find(x => x.id === gid);
  if (!g) return;
  try {
    await apiPost(`/api/groups/${encodeURIComponent(gid)}`, { hidden }, "PATCH");
    if (hidden) _agoHiddenOpen = false;
    await agoLoadGroups();
    agoDrawSide();
    if (_agoGroupPage && _agoSel.g === gid) agoDrawMain();
    toast(hidden ? `"${g.name}" hidden — find it under Hidden below the groups`
                 : `"${g.name}" is back in the sidebar`, { variant: "ok" });
  } catch (e) { agoErr(hidden ? "Couldn't hide group" : "Couldn't show group", e); }
}

async function agoSetChannelHidden(gid, cid, hidden) {
  const g = _agoGroups.find(x => x.id === gid);
  const c = g && (g.channels || []).find(x => x.id === cid);
  if (!c) return;
  try {
    await apiPost(
      `/api/groups/${encodeURIComponent(gid)}/channels/${encodeURIComponent(cid)}`,
      { hidden }, "PATCH");
    await agoLoadGroups();
    agoDrawSide();
    if (_agoGroupPage && _agoSel.g === gid) agoDrawMain();
    toast(hidden ? `#${c.name} hidden — find it under Hidden below the groups`
                 : `#${c.name} is back in the sidebar`, { variant: "ok" });
  } catch (e) { agoErr(hidden ? "Couldn't hide channel" : "Couldn't show channel", e); }
}

/* Dismiss a thread from the sidebar + inbox (two-step confirm). The
   messages stay in the channel — this only clears the inbox row. */
async function agoHideThread(rootId) {
  if (!agoArmed("thr:" + rootId)) {
    agoArm("thr:" + rootId, () => { agoDrawSide(); if (_agoInboxOpen) agoDrawMain(); });
    return;
  }
  agoDisarm();
  try {
    await apiPost(`/api/threads/${rootId}/hide`, {}, "PUT");
    _agoThreads = _agoThreads.filter(t => !(t.root && t.root.id === rootId));
    agoDrawSide();
    if (_agoInboxOpen) agoDrawMain();
    toast("Thread removed from the sidebar", { variant: "ok" });
  } catch (e) { agoErr("Couldn't remove thread", e); }
}

/* Rename a thread with a display alias (blank clears it back to the first
   message). Anyone who can see the thread may rename it. */
async function agoRenameThread(rootId) {
  const t = _agoThreads.find(x => x.root && x.root.id === rootId);
  const cur = t && t.root ? (t.root.alias || "") : "";
  const next = window.prompt(
    "Rename this thread (leave blank to show the first message):", cur);
  if (next === null) return;
  try {
    await apiPost(`/api/threads/${rootId}`, { alias: next.trim() }, "PATCH");
    if (t && t.root) t.root.alias = next.trim() || null;
    agoDrawSide();
    if (_agoInboxOpen) agoDrawMain();
  } catch (e) { agoErr("Couldn't rename thread", e); }
}

/* ---------- group overview page ---------- */
function agoDrawGroupPage(box) {
  const g = agoSelGroup();
  if (!g) { _agoGroupPage = false; agoDrawMain(); return; }
  const admin = g.role === "admin" || isOwner();
  const armed = agoArmed("group:" + g.id);
  const desc = (g.description || "").trim();
  const chans = (g.channels || []).map(c => {
    const unread = agoUnreadCount(c.id);
    const mentions = agoMentionCount(c.id);
    const eye = admin
      ? `<button class="ago-x show" title="${c.hidden ? "Show #" + esc(c.name) + " in the sidebar" : "Hide #" + esc(c.name) + " from the sidebar"}"
           onclick="event.stopPropagation(); agoSetChannelHidden('${esc(g.id)}','${esc(c.id)}',${c.hidden ? "false" : "true"})">${icon(c.hidden ? "eye" : "eye-off")}</button>`
      : "";
    return `
      <div class="ago-inbox-row ago-gp-chan ${unread || mentions ? "unread" : ""} ${c.hidden ? "is-hidden" : ""}"
           onclick="agoSelectChannel('${esc(g.id)}','${esc(c.id)}')" title="Open #${esc(c.name)}">
        <div class="ago-inbox-top">
          <span class="chan"><span class="hash">#</span>${esc(c.name)}${c.hidden ? '<span class="ago-hidden-tag">hidden</span>' : ""}</span>
          ${agoBadgeHTML(unread, mentions)}
          ${eye}
        </div>
        ${c.topic ? `<div class="ago-gp-topic">${esc(c.topic)}</div>` : ""}
      </div>`;
  }).join("");
  const n = (g.channels || []).length;
  box.innerHTML = `
    <div class="ago-head">
      <button class="btn sm ago-back" title="Back to groups" onclick="agoBackToGroups()">${icon("chevron-left")}</button>
      <div class="ago-head-text">
        <span class="ago-chan-name">${esc(g.name)}${g.hidden ? '<span class="ago-hidden-tag">hidden</span>' : ""}</span>
        <span class="dim">${n} channel${n === 1 ? "" : "s"}</span>
      </div>
      <div class="ago-head-actions">
        ${admin
          ? `<button class="btn sm" title="${g.hidden
                 ? "Bring this group back into the sidebar"
                 : "Tuck this group away — everything stays intact, it just leaves the sidebar"}"
               onclick="agoSetGroupHidden('${esc(g.id)}',${g.hidden ? "false" : "true"})">
               ${icon(g.hidden ? "eye" : "eye-off")} ${g.hidden ? "Show group" : "Hide group"}</button>
             <button class="btn sm danger ${armed ? "armed" : ""}" onclick="agoDeleteGroup('${esc(g.id)}')">
               ${armed ? "Sure? This deletes everything" : "Delete group"}</button>`
          : ""}
      </div>
    </div>
    <div class="ago-log ago-inbox-list">
      ${desc ? `<div class="ago-gp-desc">${esc(desc)}</div>` : ""}
      ${chans
        || `<div class="empty"><div class="glyph">${icon("layout-grid")}</div>
            <div>No channels yet</div>
            <div class="hint">Add a channel from the sidebar to start chatting in ${esc(g.name)}.</div></div>`}
    </div>`;
}

/* ---------- main column (messages + composer) ---------- */
function agoDrawMain() {
  const box = document.getElementById("agora-main");
  if (!box) return;
  if (_agoUnreadsOpen) { agoDrawUnreads(box); return; }
  if (_agoInboxOpen) { agoDrawInbox(box); return; }
  if (_agoGroupPage) { agoDrawGroupPage(box); return; }
  const group = agoSelGroup();
  const channel = agoSelChannel();
  if (!channel) {
    box.innerHTML = `
      <div class="ago-head ago-head-empty">
        <button class="btn sm ago-back" title="Back to groups" onclick="agoBackToGroups()">${icon("chevron-left")}</button>
        <div class="ago-head-text"><span class="ago-chan-name">Agora</span></div>
      </div>
      <div class="empty"><div class="glyph">${icon("layout-grid")}</div>
      <div>${group ? "No channel selected" : "Welcome to Agora"}</div>
      <div class="hint">${group
        ? "Pick or create a channel in this group to start chatting."
        : "Create a group on the left, add channels inside it, then invite agents to chat with."}</div></div>`;
    return;
  }
  const noAgents = !_agoChanAgents.length
    ? `<div class="ago-hint-banner">No agents are listening in this channel yet.
         Open <b>Members</b> and add one — connect agents first via <b>Connections</b>
         (top right).</div>`
    : "";
  const draft = (document.getElementById("ago-msg") || {}).value || "";
  const headText = _agoEditingChan
    ? `<div class="ago-head-text ago-chan-edit">
        <input id="ago-edit-name" value="${esc(channel.name)}" placeholder="channel name"
          onkeydown="if(event.key==='Enter')agoSaveChanEdit();if(event.key==='Escape')agoCancelChanEdit()">
        <input id="ago-edit-topic" value="${esc(channel.topic || "")}" placeholder="topic (optional)"
          onkeydown="if(event.key==='Enter')agoSaveChanEdit();if(event.key==='Escape')agoCancelChanEdit()">
        <button class="btn sm primary" onclick="agoSaveChanEdit()">Save</button>
        <button class="btn sm" onclick="agoCancelChanEdit()">Cancel</button>
      </div>`
    : `<div class="ago-head-text">
        <span class="ago-chan-name"><span class="hash">#</span>${esc(channel.name)}</span>
        <span class="dim" title="${esc(channel.topic || "")}">${esc(channel.topic || group.name)}</span>
        ${agoIsAdmin()
          ? `<button class="ago-edit-btn" title="Rename #${esc(channel.name)} / edit topic"
               onclick="agoStartChanEdit()">${icon("pencil")}</button>`
          : ""}
      </div>`;
  box.innerHTML = `
    <div class="ago-head">
      <button class="btn sm ago-back" title="Back to groups" onclick="agoBackToGroups()">${icon("chevron-left")}</button>
      ${headText}
      <div class="ago-head-actions">
        ${_agoVoiceOK ? `
        <button class="btn sm ago-speak-btn ${_agoSpeakAll ? "active" : ""}"
          title="${_agoSpeakAll
            ? "Stop speaking agent replies aloud"
            : "Speak agent replies aloud (applies to every channel)"}"
          onclick="agoSpeakToggle()">${_agoSpeakAll ? icon("volume-2") : icon("volume-x")}</button>
        <button class="btn sm ago-live-btn ${agoLiveScopeActive(null) ? "active" : ""}"
          title="${agoLiveScopeActive(null)
            ? "End the live voice conversation"
            : "Live voice: talk hands-free and hear the replies"}"
          onclick="agoLiveToggle(null)">${icon("headphones")} Live</button>` : ""}
        <button class="btn sm ago-star-toggle ${_agoStarsOpen ? "active" : ""}"
          title="Starred messages in #${esc(channel.name)}"
          onclick="agoToggleStarList()">${_agoStars.length ? icon("star", "fill") + " " + _agoStars.length : icon("star")}</button>
        <button class="btn sm ${_agoMembers ? "active" : ""}" onclick="agoToggleMembers()">Members</button>
      </div>
    </div>
    ${agoPinBarHTML()}
    ${agoStarPopHTML()}
    ${noAgents}
    <div class="ago-unread-bar" id="ago-unread-bar" style="display:none"></div>
    <div class="ago-log" id="ago-log" onscroll="agoOnScroll()"></div>
    <div class="ago-status" id="ago-status"></div>
    ${agoLiveStripHTML(null)}
    ${agoAddrChipsHTML(null)}
    ${agoFileChipsHTML(null)}
    <div class="chat-input" ondragover="agoDragOver(event)" ondrop="agoDrop(event, null)">
      ${agoAddrBtnHTML(null)}
      <textarea id="ago-msg" rows="1" placeholder="Message #${esc(channel.name)}"
        title="@mention an agent to address it directly"
        onkeydown="agoKeydown(event, null)" oninput="autoGrow(this); agoMentionInput('ago-msg')"
        onpaste="agoPaste(event, null)"
        onblur="setTimeout(agoCloseMention, 150)"></textarea>
      ${agoAttachBtnHTML(null)}
      ${agoVoiceBtnHTML(null)}
      <button class="btn primary" onclick="agoSend(null)">Send</button>
      ${agoAddrPopHTML(null)}
    </div>`;
  const msgBox = document.getElementById("ago-msg");
  if (msgBox && draft) { msgBox.value = draft; autoGrow(msgBox); }
  if (_agoEditingChan) {
    const nameInput = document.getElementById("ago-edit-name");
    if (nameInput) { nameInput.focus(); nameInput.select(); }
  }
  agoDrawMessages();
  agoDrawStatus();
  agoDrawMembers();
}

/* ---------- channel rename / topic ---------- */
function agoStartChanEdit() { _agoEditingChan = true; agoDrawMain(); }
function agoCancelChanEdit() { _agoEditingChan = false; agoDrawMain(); }
async function agoSaveChanEdit() {
  const group = agoSelGroup();
  const channel = agoSelChannel();
  const name = (document.getElementById("ago-edit-name") || {}).value || "";
  const topic = (document.getElementById("ago-edit-topic") || {}).value || "";
  if (!group || !channel) return;
  if (!name.trim()) { agoErr("Rename failed", "channel name can't be empty"); return; }
  try {
    await apiPost(
      `/api/groups/${encodeURIComponent(group.id)}/channels/${encodeURIComponent(channel.id)}`,
      { name: name.trim(), topic: topic.trim() }, "PATCH");
    _agoEditingChan = false;
    await agoLoadGroups();
    agoDrawSide();
    agoDrawMain();
  } catch (e) { agoErr("Couldn't update channel", e); }
}

/* ---------- pinned threads ---------- */
function agoIsPinned(id) { return _agoPins.some(p => p.id === id); }

function agoPinSnippet(m) {
  const alias = (m.alias || "").trim();
  if (alias) return alias;
  return (m.text || "").split("\n")[0].slice(0, 140);
}

function agoPinBarHTML() {
  if (!_agoPins.length) return "";
  const first = _agoPins[0];
  const rows = _agoPinsOpen ? `
    <div class="ago-pin-pop">
      ${_agoPins.map(p => `
        <div class="ago-pin-row" onclick="agoOpenPin(${p.id})" title="Open thread">
          <div class="ago-pin-row-main">
            <span class="ago-pin-author">${esc(agoAuthorLabel(p))}</span>
            <span class="ago-pin-text">${esc(agoPinSnippet(p))}</span>
          </div>
          <span class="ago-pin-meta">${p.reply_count ? p.reply_count + " repl" + (p.reply_count === 1 ? "y" : "ies") + " · " : ""}${esc(fmtTs(p.ts))}</span>
          <button class="ago-x" title="Unpin"
            onclick="event.stopPropagation(); agoTogglePin(${p.id})">${icon("x")}</button>
        </div>`).join("")}
    </div>` : "";
  return `
    <div class="ago-pin-wrap">
      <button class="ago-pinbar ${_agoPinsOpen ? "open" : ""}" onclick="agoTogglePinList()"
        title="${_agoPinsOpen ? "Hide pinned threads" : "Show pinned threads"}">
        <span class="ago-pin-ico">${icon("pin")}</span>
        <span class="ago-pin-count">${_agoPins.length} pinned</span>
        ${!_agoPinsOpen ? `<span class="ago-pin-preview">${esc(agoPinSnippet(first))}</span>` : ""}
        <span class="ago-pin-caret">${_agoPinsOpen ? icon("chevron-up") : icon("chevron-down")}</span>
      </button>
      ${rows}
    </div>`;
}

function agoTogglePinList() {
  _agoPinsOpen = !_agoPinsOpen;
  if (_agoPinsOpen) _agoStarsOpen = false;
  agoDrawMain();
}

function agoOpenPin(id) {
  _agoPinsOpen = false;
  agoDrawMain();
  agoOpenThread(id).catch(console.error);
}

async function agoTogglePin(id) {
  const channel = agoSelChannel();
  if (!channel) return;
  const pinned = agoIsPinned(id);
  try {
    await apiPost(
      `/api/channels/${encodeURIComponent(channel.id)}/pins/${id}`,
      {}, pinned ? "DELETE" : "PUT");
  } catch (e) { agoErr(pinned ? "Couldn't unpin" : "Couldn't pin", e); }
}

function agoApplyPin(data) {
  if (data.pinned && data.pin) {
    if (!agoIsPinned(data.pin.id)) _agoPins.unshift(data.pin);
  } else if (!data.pinned) {
    _agoPins = _agoPins.filter(p => p.id !== data.message_id);
    if (!_agoPins.length) _agoPinsOpen = false;
  }
  agoDrawMain();
  if (_agoThreadRoot) agoDrawThread();
}

/* ---------- starred messages ---------- */
function agoIsStarred(id) { return _agoStars.some(s => s.id === id); }

function agoToggleStarList() {
  _agoStarsOpen = !_agoStarsOpen;
  if (_agoStarsOpen) _agoPinsOpen = false;
  agoDrawMain();
}

function agoStarPopHTML() {
  if (!_agoStarsOpen) return "";
  const rows = _agoStars.length ? _agoStars.map(s => `
    <div class="ago-pin-row" onclick="agoOpenStar(${s.id})"
         title="${s.thread_id != null ? "Open in its thread" : "Jump to message"}">
      <div class="ago-pin-row-main">
        <span class="ago-pin-author">${esc(agoAuthorLabel(s))}</span>
        <span class="ago-pin-text">${esc(agoPinSnippet(s))}</span>
      </div>
      <span class="ago-pin-meta">${s.thread_id != null ? "in thread · " : ""}${esc(fmtTs(s.ts))}</span>
      <button class="ago-x" title="Unstar"
        onclick="event.stopPropagation(); agoToggleStar(${s.id})">${icon("x")}</button>
    </div>`).join("")
    : `<div class="dim" style="padding:10px 12px;font-size:12px">
         Nothing starred in this channel yet — hover a message and hit ${icon("star")} star.</div>`;
  return `<div class="ago-pin-wrap"><div class="ago-pin-pop">${rows}</div></div>`;
}

async function agoToggleStar(id) {
  const channel = agoSelChannel();
  if (!channel) return;
  const starred = agoIsStarred(id);
  try {
    await apiPost(
      `/api/channels/${encodeURIComponent(channel.id)}/stars/${id}`,
      {}, starred ? "DELETE" : "PUT");
    if (starred) {
      _agoStars = _agoStars.filter(s => s.id !== id);
      if (!_agoStars.length) _agoStarsOpen = false;
    } else {
      const data = await api(`/api/channels/${encodeURIComponent(channel.id)}/stars`);
      _agoStars = data.stars || [];
    }
    agoDrawMain();
    if (_agoThreadRoot) agoDrawThread();
  } catch (e) { agoErr(starred ? "Couldn't unstar" : "Couldn't star", e); }
}

async function agoOpenStar(id) {
  const s = _agoStars.find(x => x.id === id);
  _agoStarsOpen = false;
  agoDrawMain();
  if (!s) return;
  await agoJumpToMessage(_agoSel.g, _agoSel.c, s.thread_id, id);
}

/* Jump to a message wherever it lives (stars, search): select its
   group/channel if it isn't the one on screen (mirrors agoGoToThread),
   open its thread when it's a reply, then scroll to it and flash it. */
async function agoJumpToMessage(gid, cid, threadId, mid) {
  const wasElsewhere = _agoInboxOpen || _agoGroupPage;
  _agoInboxOpen = false;
  _agoGroupPage = false;
  if (_agoSel.c !== cid || _agoSel.g !== gid) {
    agoSetExpanded(gid, true);
    _agoFiles = {};
    _agoSel.g = gid; _agoSel.c = cid;
    _agoThreadRoot = null; _agoThreadMsgs = []; _agoMembers = null;
    _agoPins = []; _agoPinsOpen = false;
    _agoStars = []; _agoStarsOpen = false;
    agoSaveSel();
    _agoCreating = null;
    agoDisarm();
    agoDrawSide();
    await agoLoadChannel();
  } else if (wasElsewhere) {
    agoDrawSide();
    agoDrawMain();
  }
  const channel = agoSelChannel();
  if (!channel) return;
  if (threadId != null) {
    await agoOpenThread(threadId);
    agoFlashMessage("ago-thread-log", mid);
    return;
  }
  agoSetView("main");
  if (!_agoMsgs.some(m => m.id === mid)) {
    try {
      const data = await api(
        `/api/channels/${encodeURIComponent(channel.id)}/messages?before_id=${mid + 1}&limit=100`);
      _agoMsgs = data.messages || [];
      agoDrawMessages();
    } catch (e) { return; }
  }
  agoFlashMessage("ago-log", mid);
}

function agoFlashMessage(containerId, mid) {
  const box = document.getElementById(containerId);
  const el = box && box.querySelector(`[data-mid="${mid}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.classList.add("ago-flash");
  setTimeout(() => el.classList.remove("ago-flash"), 1800);
}

function agoAuthorLabel(m) {
  return m.author_name || m.author_id;
}

/* ---------- @mention rendering in bubbles ---------- */
const AGO_MENTION_RE = /(^|[\s(>])@([A-Za-z0-9][\w.-]*)/g;

function agoMentionIndex() {
  const map = {};
  const add = (key, name) => { if (key) map[String(key).toLowerCase()] = name; };
  for (const a of _agoAvailAgents.concat(_agoChanAgents)) {
    add(a.id, a.name);
    add(agoSlug(a.name), a.name);
  }
  const g = agoSelGroup();
  for (const m of (g && _agoGroupMembers[g.id]) || []) {
    if (m.member_type === "user") add(m.member_id, m.member_id);
  }
  return map;
}

function agoMd(text) {
  const map = agoMentionIndex();
  return mdLite(text)
    .split(/(<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>)/)
    .map((seg, i) => i % 2 ? seg : seg.replace(AGO_MENTION_RE, (all, pre, token) => {
      let key = token.toLowerCase(), tail = "";
      while (key && !(key in map) && /[._-]$/.test(key)) {
        tail = key.slice(-1) + tail;
        key = key.slice(0, -1);
      }
      const name = map[key];
      if (!name) return all;
      return `${pre}<span class="ago-mention" title="@${esc(key)}">${esc(name)}</span>${tail}`;
    }))
    .join("");
}
function agoBubble(m, inThread) {
  const mine = m.author_type === "user" && CURRENT_USER && m.author_id === CURRENT_USER.username;
  const cls = m.author_type === "agent" ? "assistant" : (mine ? "user" : "assistant peer");
  const replies = !inThread && m.reply_count
    ? `<button class="ago-replies" onclick="agoOpenThread(${m.id})">${m.reply_count} repl${m.reply_count === 1 ? "y" : "ies"} →</button>`
    : "";
  const threadBtn = !inThread
    ? `<button class="ago-thread-btn" title="Reply in thread" onclick="agoOpenThread(${m.id})">${icon("corner-down-right")} thread</button>`
    : "";
  const pinnable = m.thread_id == null;
  const pinned = pinnable && agoIsPinned(m.id);
  const pinBtn = pinnable
    ? `<button class="ago-thread-btn ago-pin-btn ${pinned ? "pinned" : ""}"
         title="${pinned ? "Unpin this thread" : "Pin this thread for quick access"}"
         onclick="agoTogglePin(${m.id})">${pinned ? icon("pin-off") + " unpin" : icon("pin") + " pin"}</button>`
    : "";
  const starred = agoIsStarred(m.id);
  const starBtn = `<button class="ago-thread-btn ago-star-btn ${starred ? "starred" : ""}"
       title="${starred ? "Remove from your starred messages" : "Star this message"}"
       onclick="agoToggleStar(${m.id})">${starred ? icon("star", "fill") + " starred" : icon("star") + " star"}</button>`;
  const foot = `<div class="ago-bubble-foot">${replies}${threadBtn}${pinBtn}${starBtn}</div>`;
  const mark = (pinned ? `<span class="ago-pinned-mark" title="Pinned">${icon("pin")}</span>` : "")
    + (starred ? `<span class="ago-starred-mark" title="Starred by you">${icon("star", "fill")}</span>` : "");
  return `<div class="bubble ${cls} ago-bubble" data-mid="${m.id}"><div class="who"><span class="who-name">${esc(agoAuthorLabel(m))}${m.author_type === "agent" ? " · agent" : ""}</span>${mark}<span class="bubble-ts">${esc(fmtTs(m.ts))}</span></div>${agoMd(m.text)}${agoAttachmentsHTML(m)}${agoOptionsHTML(m)}${foot}</div>`;
}
function agoOptionsHTML(m) {
  const meta = m.meta;
  if (!meta || !Array.isArray(meta.options) || !meta.options.length) return "";
  const resolved = meta.resolved && typeof meta.resolved === "object" ? meta.resolved : null;
  if (resolved) {
    const label = resolved.label
      || (meta.options.find(o => o.id === resolved.option_id) || {}).label
      || resolved.option_id
      || "Resolved";
    const by = resolved.by ? ` by ${esc(resolved.by)}` : "";
    return `<div class="ago-options resolved"><span class="ago-option-result">${esc(label)}${by}</span></div>`;
  }
  const buttons = meta.options.map(o => {
    const style = o.style === "primary" ? "primary" : (o.style === "danger" ? "danger" : "");
    return `<button class="ago-option-btn ${style}" onclick="agoSelectOption(${m.id}, '${esc(o.id)}')">${esc(o.label || o.id)}</button>`;
  }).join("");
  return `<div class="ago-options">${buttons}</div>`;
}
async function agoSelectOption(messageId, optionId) {
  try {
    await apiPost(`/api/messages/${messageId}/select`, { option_id: optionId });
  } catch (e) {
    alert(e.message || "Could not submit choice");
  }
}
function agoMsgHTML(m, inThread) {
  const bubble = agoBubble(m, inThread);
  if (m.author_type !== "agent") return bubble;
  return `<div class="ago-msg-row">${agoAgentAvatarHTML(m.author_id)}${bubble}</div>`;
}
function agoDrawMessages() {
  const box = document.getElementById("ago-log");
  if (!box) return;
  const wasAtBottom = !box.childElementCount || agoAtBottom(box);
  const prevTop = box.scrollTop;
  let html = "";
  let dividerPlaced = false;
  for (const m of _agoMsgs) {
    if (!dividerPlaced && _agoDividerAfter != null && m.id > _agoDividerAfter) {
      html += `<div class="ago-new-divider" id="ago-new-divider"><span>New</span></div>`;
      dividerPlaced = true;
    }
    html += agoMsgHTML(m, false);
  }
  box.innerHTML = html
    || `<div class="empty"><div class="glyph">${icon("message-circle")}</div><div>No messages yet</div>
       <div class="hint">Say something — member agents will answer here. Use the Members button to invite an agent.</div></div>`;
  const divider = dividerPlaced && document.getElementById("ago-new-divider");
  if (_agoLandOnDivider && divider) {
    _agoLandOnDivider = false;
    box.scrollTop = Math.max(0, divider.offsetTop - 8);
  } else if (wasAtBottom) {
    box.scrollTop = box.scrollHeight;
  } else {
    box.scrollTop = prevTop;
  }
  agoDrawUnreadBar();
  agoMaybeMarkRead();
}

function agoStatusHTML(progress, typing) {
  const parts = progress.map(p =>
    `<div class="ago-progress">${icon("loader", "spin")} <b>${esc(p.agent_name)}</b> ${esc(p.text)}</div>`);
  if (typing.length) {
    const names = typing.map(t => esc(t.name));
    parts.push(`<div class="ago-typing">${names.join(", ")} typing<span class="dots">…</span></div>`);
  }
  return parts.join("");
}
function agoDrawStatus() {
  const openThread = _agoThreadRoot ? String(_agoThreadRoot.id) : null;
  const inOpenThread = x => openThread !== null && x.thread_id != null && String(x.thread_id) === openThread;
  const main = document.getElementById("ago-status");
  if (main) {
    main.innerHTML = agoStatusHTML(
      Object.values(_agoProgress).filter(p => !inOpenThread(p)),
      Object.values(_agoTyping).filter(t => !inOpenThread(t)));
  }
  const thread = document.getElementById("ago-thread-status");
  if (thread) {
    thread.innerHTML = agoStatusHTML(
      Object.values(_agoProgress).filter(inOpenThread),
      Object.values(_agoTyping).filter(inOpenThread));
  }
}

function agoInsertMention(slug) {
  const input = document.getElementById("ago-msg");
  if (!input) return;
  input.value = (input.value ? input.value.replace(/\s*$/, " ") : "") + "@" + slug + " ";
  input.focus();
}

/* ---------- @mention autocomplete ---------- */
async function agoMentionCandidates() {
  const g = agoSelGroup();
  if (!g) return [];
  let members = _agoGroupMembers[g.id];
  if (!members) {
    try {
      members = (await api(`/api/groups/${encodeURIComponent(g.id)}/members`)).members || [];
    } catch (e) { members = []; }
    _agoGroupMembers[g.id] = members;
  }
  const me = CURRENT_USER ? CURRENT_USER.username : null;
  const agents = _agoChanAgents.map(a =>
    ({ type: "agent", id: a.id, name: a.name, slug: agoSlug(a.name) }));
  const people = members
    .filter(m => m.member_type === "user" && m.member_id !== me)
    .map(m => ({ type: "user", id: m.member_id, name: m.member_id, slug: m.member_id }));
  return agents.concat(people);
}

async function agoMentionInput(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const caret = input.selectionStart;
  const upToCaret = input.value.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  const live = at >= 0 && (at === 0 || /\s/.test(upToCaret[at - 1])) && !/\s/.test(upToCaret.slice(at + 1));
  if (!live) { agoCloseMention(); return; }
  const q = upToCaret.slice(at + 1).toLowerCase();
  const items = (await agoMentionCandidates()).filter(c =>
    c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q));
  if (!items.length) { agoCloseMention(); return; }
  const prevActive = _agoMention && _agoMention.inputId === inputId ? _agoMention.active : 0;
  _agoMention = { inputId, items, active: Math.min(prevActive, items.length - 1), start: at };
  agoDrawMention();
}

function agoDrawMention() {
  agoRemoveMentionPop();
  if (!_agoMention) return;
  const input = document.getElementById(_agoMention.inputId);
  if (!input) { _agoMention = null; return; }
  const pop = document.createElement("div");
  pop.className = "ago-mention-pop";
  pop.id = "ago-mention-pop";
  pop.innerHTML = _agoMention.items.map((c, i) => `
    <div class="ago-mention-opt ${i === _agoMention.active ? "active" : ""}"
         onmousedown="event.preventDefault(); agoPickMention(${i})">
      ${c.type === "agent" ? agoAgentAvatarHTML(c.id, "sm") : `<span class="ago-av sm">${icon("user")}</span>`}
      <span class="mname">${esc(c.name)}</span>
      <span class="mmeta">${c.type}</span>
    </div>`).join("");
  input.parentElement.appendChild(pop);
  const activeEl = pop.children[_agoMention.active];
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}
function agoRemoveMentionPop() {
  const el = document.getElementById("ago-mention-pop");
  if (el) el.remove();
}
function agoCloseMention() { _agoMention = null; agoRemoveMentionPop(); }
function agoPickMention(i) {
  if (!_agoMention) return;
  const c = _agoMention.items[i];
  const input = document.getElementById(_agoMention.inputId);
  if (!input || !c) { agoCloseMention(); return; }
  const caret = input.selectionStart;
  input.value = input.value.slice(0, _agoMention.start) + "@" + c.slug + " " + input.value.slice(caret);
  const pos = _agoMention.start + c.slug.length + 2;
  agoCloseMention();
  input.focus();
  input.setSelectionRange(pos, pos);
}

function agoKeydown(e, threadId) {
  if (_agoMention) {
    const n = _agoMention.items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      _agoMention.active = (_agoMention.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      agoDrawMention();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      agoPickMention(_agoMention.active);
      return;
    }
    if (e.key === "Escape") { agoCloseMention(); return; }
  }
  if (e.key === "Escape" && _agoAddrOpen) { agoAddrTogglePop(threadId); return; }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agoSend(threadId); }
}
async function agoSend(threadId) {
  agoCloseMention();
  if (_agoSpeakAll) await agoUnlockPlayback();   // mobile: Send tap unlocks playback
  const input = document.getElementById(threadId ? "ago-thread-msg" : "ago-msg");
  const channel = agoSelChannel();
  if (!input || !channel) return;
  const text = input.value.trim();
  const files = agoPendingFiles(threadId);
  if (!text && !files.length) return;
  // "Talk to" selection: prepend the chosen agents' mentions ("@a, @b, …")
  // so the message opens with their names and routes to exactly them.
  const addr = agoAddrPrefix(threadId);
  const outText = addr ? (text ? `${addr}, ${text}` : addr) : text;
  input.value = "";
  autoGrow(input);
  try {
    let msg;
    if (files.length) {
      const fd = new FormData();
      fd.append("text", outText);
      if (threadId != null) fd.append("thread_id", threadId);
      for (const f of files) fd.append("files", f, f.name);
      const res = await fetch(`/api/channels/${encodeURIComponent(channel.id)}/messages/upload`, {
        method: "POST", headers: authHeaders(), body: fd,
      });
      if (!res.ok) {
        let detail = await res.text();
        try { detail = JSON.parse(detail).detail || detail; } catch (e) {}
        throw new Error(detail);
      }
      msg = await res.json();
      agoClearFiles(threadId);
      agoRedrawComposer(threadId);
    } else {
      msg = await apiPost(
        `/api/channels/${encodeURIComponent(channel.id)}/messages`,
        threadId ? { text: outText, thread_id: threadId } : { text: outText });
    }
    agoIngestMessage(msg);   // websocket will dedupe by id
  } catch (e) {
    agoErr("Send failed", e);
    input.value = text;
    autoGrow(input);
  }
  const again = document.getElementById(threadId ? "ago-thread-msg" : "ago-msg");
  if (again) again.focus();
}

/* ---------- file attachments (📎 button, paste, drag-drop) ---------- */
const AGO_MAX_FILES = 5;
let _agoFiles = {};   // composer key ("main" | "t<rootId>") -> File[]

function agoRecKey(threadId) { return threadId != null ? "t" + threadId : "main"; }
function agoPendingFiles(threadId) { return _agoFiles[agoRecKey(threadId)] || []; }
function agoClearFiles(threadId) { delete _agoFiles[agoRecKey(threadId)]; }

function agoAddFiles(threadId, fileList) {
  const files = Array.from(fileList || []).filter(f => f && f.size);
  if (!files.length) return;
  const key = agoRecKey(threadId);
  const cur = _agoFiles[key] || [];
  if (cur.length + files.length > AGO_MAX_FILES) {
    toast(`Up to ${AGO_MAX_FILES} files per message`, { variant: "warn" });
    return;
  }
  _agoFiles[key] = cur.concat(files);
  agoRedrawComposer(threadId);
}

function agoRemoveFile(threadId, idx) {
  const key = agoRecKey(threadId);
  _agoFiles[key] = (_agoFiles[key] || []).filter((_, i) => i !== idx);
  if (!_agoFiles[key].length) delete _agoFiles[key];
  agoRedrawComposer(threadId);
}

/* One persistent hidden input, reused across picks. A detached transient
   input can be garbage-collected by WKWebView while the native file dialog
   is open, in which case onchange never fires and the pick is lost. */
let _agoFileInput = null;
function agoPickFiles(threadId) {
  if (!_agoFileInput) {
    _agoFileInput = document.createElement("input");
    _agoFileInput.type = "file";
    _agoFileInput.multiple = true;
    _agoFileInput.style.display = "none";
    document.body.appendChild(_agoFileInput);
  }
  _agoFileInput.onchange = () => {
    agoAddFiles(threadId, _agoFileInput.files);
    _agoFileInput.value = "";   // allow re-picking the same file
  };
  _agoFileInput.click();
}

function agoPaste(e, threadId) {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    agoAddFiles(threadId, files);
  }
}

function agoDragOver(e) { e.preventDefault(); }
function agoDrop(e, threadId) {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length) agoAddFiles(threadId, e.dataTransfer.files);
}

function agoHumanSize(n) {
  n = Number(n) || 0;
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

function agoAttachBtnHTML(threadId) {
  const arg = threadId != null ? threadId : "null";
  return `<button class="btn ago-attach" title="Attach files (or paste / drop them)"
    onclick="agoPickFiles(${arg})">${icon("paperclip")}</button>`;
}

function agoFileChipsHTML(threadId) {
  const files = agoPendingFiles(threadId);
  if (!files.length) return "";
  const arg = threadId != null ? threadId : "null";
  return `<div class="ago-pending">${files.map((f, i) => `
    <span class="ago-pending-chip" title="${esc(f.name)}">
      ${(f.type || "").startsWith("image/") ? icon("image") : icon("file-text")}
      <span class="fname">${esc(f.name)}</span>
      <span class="fsize">${agoHumanSize(f.size)}</span>
      <button class="ago-x" title="Remove" onclick="agoRemoveFile(${arg}, ${i})">${icon("x")}</button>
    </span>`).join("")}</div>`;
}

function agoRedrawComposer(threadId) {
  if (threadId != null) agoDrawThread(); else agoDrawMain();
}

/* ---------- "talk to" agent multi-select (@ button in the composer) ----------
   Pick which of the channel's agents a conversation addresses; the selection
   is keyed per channel (and per thread) and remembered for the app session,
   so it sticks for future messages until changed. On send the @mentions are
   prepended ("@a, @b, …"), so the existing mention routing delivers to
   exactly those agents. */
function agoAddrKey(threadId) {
  const c = agoSelChannel();
  return c ? (threadId != null ? `${c.id}:t${threadId}` : c.id) : null;
}

function agoAddrList(threadId) {
  const key = agoAddrKey(threadId);
  return (key && _agoAddr[key]) || [];
}

function agoAddrSelected(threadId) {
  // Resolve ids -> agent records; drops agents that left the channel.
  return agoAddrList(threadId)
    .map(id => _agoChanAgents.find(a => a.id === id))
    .filter(Boolean);
}

function agoAddrToggle(threadId, agentId) {
  const key = agoAddrKey(threadId);
  if (!key) return;
  const cur = _agoAddr[key] || [];
  _agoAddr[key] = cur.includes(agentId) ? cur.filter(id => id !== agentId) : cur.concat(agentId);
  if (!_agoAddr[key].length) delete _agoAddr[key];
  agoRedrawComposer(threadId);
  agoAddrFocus(threadId);
}

function agoAddrClear(threadId) {
  const key = agoAddrKey(threadId);
  if (key) delete _agoAddr[key];
  agoRedrawComposer(threadId);
  agoAddrFocus(threadId);
}

function agoAddrTogglePop(threadId) {
  const key = agoRecKey(threadId);
  _agoAddrOpen = _agoAddrOpen === key ? null : key;
  agoRedrawComposer(threadId);
  agoAddrFocus(threadId);
}

function agoAddrFocus(threadId) {
  const input = document.getElementById(threadId != null ? "ago-thread-msg" : "ago-msg");
  if (input) input.focus();
}

/* Click-away closes the picker (the button and popup clicks are exempt). */
document.addEventListener("click", (e) => {
  if (!_agoAddrOpen) return;
  const t = e.target;
  if (t && t.closest && (t.closest(".ago-addr-pop") || t.closest(".ago-addr-btn"))) return;
  const key = _agoAddrOpen;
  _agoAddrOpen = null;
  if (key === "main") agoDrawMain(); else agoDrawThread();
});

function agoAddrPrefix(threadId) {
  const sel = agoAddrSelected(threadId);
  if (!sel.length) return "";
  return sel.map(a => "@" + agoSlug(a.name)).join(", ");
}

function agoAddrBtnHTML(threadId) {
  if (!_agoChanAgents.length) return "";
  const arg = threadId != null ? threadId : "null";
  const n = agoAddrList(threadId).length;
  return `<button class="btn ago-addr-btn ${n ? "active" : ""}"
    title="Choose which agents you're talking to"
    onclick="agoAddrTogglePop(${arg})">${icon("bot")}${n ? `<span class="ago-addr-count">${n}</span>` : ""}</button>`;
}

function agoAddrChipsHTML(threadId) {
  const sel = agoAddrSelected(threadId);
  if (!sel.length) return "";
  const arg = threadId != null ? threadId : "null";
  return `<div class="ago-addr-bar">
    <span class="ago-addr-label">To</span>
    ${sel.map(a => `
      <span class="ago-addr-chip" title="@${esc(agoSlug(a.name))}">
        ${agoAgentAvatarHTML(a.id, "xs")}
        <span class="aname">${esc(a.name)}</span>
        <button class="ago-x" title="Stop addressing ${esc(a.name)}"
          onclick="agoAddrToggle(${arg}, '${esc(a.id)}')">${icon("x")}</button>
      </span>`).join("")}
    <button class="ago-addr-clear" title="Address everyone in the channel again"
      onclick="agoAddrClear(${arg})">Clear</button>
  </div>`;
}

function agoAddrPopHTML(threadId) {
  if (_agoAddrOpen !== agoRecKey(threadId)) return "";
  const arg = threadId != null ? threadId : "null";
  const sel = agoAddrList(threadId);
  const rows = _agoChanAgents.map(a => {
    const on = sel.includes(a.id);
    return `
    <div class="ago-addr-opt ${on ? "selected" : ""}" role="option" aria-selected="${on}"
         onclick="agoAddrToggle(${arg}, '${esc(a.id)}')">
      ${agoAgentAvatarHTML(a.id, "sm")}
      <span class="mname">${esc(a.name)}</span>
      <span class="ago-addr-check">${on ? icon("check") : ""}</span>
    </div>`;
  }).join("");
  return `<div class="ago-addr-pop" id="ago-addr-pop">
    <div class="ago-addr-pop-head">
      <span>Talk to</span>
      ${sel.length ? `<button class="ago-addr-clear" onclick="agoAddrClear(${arg})">Clear</button>` : ""}
    </div>
    ${rows || `<div class="ago-addr-empty">No agents in this channel yet.</div>`}
  </div>`;
}

/* Attachment URLs carry the token in the query — <img> tags can't set an
   Authorization header. */
function agoFileUrl(id) {
  const t = sessionToken();
  return `/api/files/${encodeURIComponent(id)}${t ? "?token=" + encodeURIComponent(t) : ""}`;
}

/* Image formats <img> can decode everywhere. HEIC/HEIF/AVIF render as
   download chips instead of broken inline images (only Safari decodes HEIC;
   mobile converts to JPEG before upload, so these stay rare). */
const AGO_BROWSER_IMAGE = /^image\/(jpeg|png|gif|webp|svg\+xml|bmp)$/;

function agoAttachmentsHTML(m) {
  const files = m.attachments || [];
  if (!files.length) return "";
  const parts = files.map(f => {
    const url = agoFileUrl(f.id);
    if (AGO_BROWSER_IMAGE.test(f.mime || "")) {
      return `<a class="ago-att-img" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(f.filename)}" loading="lazy"></a>`;
    }
    const ico = (f.mime || "").startsWith("image/") ? icon("image") : icon("file-text");
    return `<a class="ago-att-file" href="${url}" download="${esc(f.filename)}" title="Download ${esc(f.filename)}">${ico} <span class="fname">${esc(f.filename)}</span> <span class="fsize">${agoHumanSize(f.size)}</span></a>`;
  });
  return `<div class="ago-atts">${parts.join("")}</div>`;
}

/* ---------- thread panel ---------- */
async function agoOpenThread(rootId) {
  const channel = agoSelChannel();
  if (!channel) return;
  // Switching threads discards a recording from the previous thread composer,
  // and ends a live session that was scoped to the previous thread.
  if (_agoRec && _agoRec.threadId != null && _agoRec.threadId !== rootId) agoVoiceCancel();
  if (_agoLive && _agoLive.threadId != null && _agoLive.threadId !== rootId) agoLiveStop();
  _agoThreadRoot = _agoMsgs.find(m => m.id === rootId)
    || _agoPins.find(p => p.id === rootId)
    || (_agoStars.find(s => s.root && s.root.id === rootId) || {}).root
    || null;
  if (!_agoThreadRoot) {
    // Root outside the loaded window (threads inbox, old pin, deep link):
    // fetch it directly instead of silently doing nothing.
    try {
      const m = await api(`/api/messages/${rootId}`);
      if (m && m.id && m.channel_id === channel.id) _agoThreadRoot = m;
    } catch (e) { /* falls through to the guard below */ }
  }
  if (!_agoThreadRoot) return;
  if (_agoMembers) { _agoMembers = null; agoDrawMembers(); agoDrawMain(); }
  try {
    const data = await api(
      `/api/channels/${encodeURIComponent(channel.id)}/messages?thread_id=${rootId}&limit=100`);
    _agoThreadMsgs = data.messages || [];
  } catch (e) { _agoThreadMsgs = []; }
  agoSetView("thread");
  agoDrawThread();
  const input = document.getElementById("ago-thread-msg");
  if (input) input.focus();
  agoMaybeMarkThreadRead();
}
function agoCloseThread() {
  // Discard a recording — and end a live session — scoped to this thread.
  if (_agoRec && _agoRec.threadId != null) agoVoiceCancel();
  if (_agoLive && _agoLive.threadId != null) agoLiveStop();
  _agoThreadRoot = null;
  _agoThreadMsgs = [];
  agoSetView("main");
  agoDrawThread();
}
function agoDrawThread() {
  const box = document.getElementById("agora-thread");
  if (!box) return;
  agoApplyThreadState();
  if (!_agoThreadRoot) {
    box.style.display = "none"; box.innerHTML = "";
    agoDrawStatus();
    return;
  }
  const channel = agoSelChannel();
  const draft = (document.getElementById("ago-thread-msg") || {}).value || "";
  box.style.display = "";
  box.innerHTML = `
    <div class="ago-head">
      <button class="btn sm ago-back" title="Back to #${esc(channel ? channel.name : "channel")}"
        onclick="agoCloseThread()">${icon("chevron-left")}</button>
      <div class="ago-head-text">
        <span class="ago-chan-name">Thread</span>
        ${channel ? `<span class="dim"><span class="hash">#</span>${esc(channel.name)}</span>` : ""}
      </div>
      <div class="ago-head-actions">
        ${_agoVoiceOK ? `
        <button class="btn sm ago-live-btn ${agoLiveScopeActive(_agoThreadRoot.id) ? "active" : ""}"
          title="${agoLiveScopeActive(_agoThreadRoot.id)
            ? "End the live voice conversation in this thread"
            : "Live voice in this thread: talk hands-free, turns post here"}"
          onclick="agoLiveToggle(${_agoThreadRoot.id})">${icon("headphones")} Live</button>` : ""}
        <button class="btn sm ${agoIsPinned(_agoThreadRoot.id) ? "active" : ""}"
          title="${agoIsPinned(_agoThreadRoot.id) ? "Unpin this thread" : "Pin this thread for quick access"}"
          onclick="agoTogglePin(${_agoThreadRoot.id})">${agoIsPinned(_agoThreadRoot.id) ? icon("pin", "fill") + " Pinned" : icon("pin") + " Pin"}</button>
        <button class="btn sm ago-thread-expand" title="${_agoThreadExpanded ? "Shrink thread back to the side panel" : "Expand thread to full width"}"
          onclick="agoToggleThreadSize()">${_agoThreadExpanded ? icon("minimize-2") : icon("maximize-2")}</button>
        <button class="btn sm ago-thread-close" onclick="agoCloseThread()">${icon("x")}</button>
      </div>
    </div>
    <div class="ago-log ago-thread-log" id="ago-thread-log" onscroll="agoOnThreadScroll()">
      ${agoMsgHTML(_agoThreadRoot, true)}
      <div class="ago-thread-sep">${_agoThreadMsgs.length} repl${_agoThreadMsgs.length === 1 ? "y" : "ies"}</div>
      ${_agoThreadMsgs.map(m => agoMsgHTML(m, true)).join("")}
    </div>
    <div class="ago-status" id="ago-thread-status"></div>
    ${agoLiveStripHTML(_agoThreadRoot.id)}
    ${agoAddrChipsHTML(_agoThreadRoot.id)}
    ${agoFileChipsHTML(_agoThreadRoot.id)}
    <div class="chat-input" ondragover="agoDragOver(event)" ondrop="agoDrop(event, ${_agoThreadRoot.id})">
      ${agoAddrBtnHTML(_agoThreadRoot.id)}
      <textarea id="ago-thread-msg" rows="1" placeholder="Reply in thread…"
        onkeydown="agoKeydown(event, ${_agoThreadRoot.id})" oninput="autoGrow(this); agoMentionInput('ago-thread-msg')"
        onpaste="agoPaste(event, ${_agoThreadRoot.id})"
        onblur="setTimeout(agoCloseMention, 150)"></textarea>
      ${agoAttachBtnHTML(_agoThreadRoot.id)}
      ${agoVoiceBtnHTML(_agoThreadRoot.id)}
      <button class="btn primary" onclick="agoSend(${_agoThreadRoot.id})">Send</button>
      ${agoAddrPopHTML(_agoThreadRoot.id)}
    </div>`;
  const input = document.getElementById("ago-thread-msg");
  if (input && draft) { input.value = draft; autoGrow(input); }
  const log = document.getElementById("ago-thread-log");
  if (log) log.scrollTop = log.scrollHeight;
  agoDrawStatus();
}

/* ---------- members panel ---------- */
async function agoToggleMembers() {
  if (_agoMembers) { _agoMembers = null; agoDrawMembers(); agoDrawMain(); return; }
  const g = agoSelGroup();
  if (!g) return;
  try {
    const [members, agents] = await Promise.all([
      api(`/api/groups/${encodeURIComponent(g.id)}/members`),
      api("/api/agents"),
    ]);
    _agoMembers = members.members || [];
    _agoAvailAgents = agents.agents || [];
  } catch (e) { agoErr("Couldn't load members", e); return; }
  if (_agoThreadRoot) { _agoThreadRoot = null; _agoThreadMsgs = []; agoDrawThread(); }
  agoDrawMembers();
  agoDrawMain();
}
function agoDrawMembers() {
  const box = document.getElementById("agora-members-pane");
  if (!box) return;
  if (!_agoMembers) { box.style.display = "none"; box.innerHTML = ""; return; }
  const g = agoSelGroup();
  if (!g) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "";
  const admin = agoIsAdmin();
  const chanName = id => {
    const c = (g.channels || []).find(x => x.id === id);
    return c ? "#" + c.name : id;
  };
  const liveById = Object.fromEntries(_agoAvailAgents.map(a => [a.id, a.live]));
  const rows = _agoMembers.map(m => {
    const off = m.member_type === "agent" && liveById[m.member_id] === false;
    const mark = m.member_type === "agent"
      ? agoAgentAvatarHTML(m.member_id, "sm")
      : `<span class="ago-av sm">${icon("user")}</span>`;
    return `
    <div class="ago-member">
      ${mark}
      <span class="mname">${esc(m.name || m.member_id)}</span>
      <span class="mmeta">${esc(m.role)}${m.channel_id ? " · " + esc(chanName(m.channel_id)) : ""}${off
        ? ' · <span class="ago-off" title="Offline — won\u2019t reply">offline</span>' : ""}</span>
      ${admin ? `<button class="ago-x" title="Remove"
        onclick="agoRemoveMember('${esc(m.member_type)}','${esc(m.member_id)}','${esc(m.channel_id || "")}')">${icon("x")}</button>` : ""}
    </div>`;
  }).join("");
  const agentOpts = _agoAvailAgents.map(a =>
    `<option value="${esc(a.id)}">${esc(a.name)}${a.live ? "" : " (offline)"}</option>`).join("");
  const chanOpts = `<option value="">whole group</option>` + (g.channels || []).map(c =>
    `<option value="${esc(c.id)}">#${esc(c.name)}</option>`).join("");
  const addForms = admin ? `
    <div class="ago-member-add">
      <select id="ago-add-agent">${agentOpts || '<option value="">no agents yet</option>'}</select>
      <select id="ago-add-agent-chan">${chanOpts}</select>
      <button class="btn sm" onclick="agoAddAgent()">Add agent</button>
    </div>
    <p class="ago-member-hint">No agents in the list? Link a Pantheo instance or pair a
      bridge under <b>Connections</b> first. Scope an agent to one channel, or give it
      the whole group.</p>` : "";
  box.innerHTML = `
    <div class="ago-head">
      <div class="ago-head-text">
        <span class="ago-chan-name">Members</span>
        <span class="dim">${esc(g.name)}</span>
      </div>
      <button class="btn sm" title="Close members" onclick="agoToggleMembers()">${icon("x")}</button>
    </div>
    <div class="ago-members-body">
      <div class="ago-member-list">${rows || '<div class="dim" style="padding:6px 0;font-size:12px">No members yet.</div>'}</div>
      ${addForms}
    </div>`;
}
async function agoAddAgent() {
  const g = agoSelGroup();
  const sel = document.getElementById("ago-add-agent");
  const chan = document.getElementById("ago-add-agent-chan");
  if (!g || !sel || !sel.value) return;
  const picked = _agoAvailAgents.find(a => a.id === sel.value);
  try {
    await apiPost(`/api/groups/${encodeURIComponent(g.id)}/members`, {
      member_type: "agent", member_id: sel.value, channel_id: chan.value || null,
    });
    _agoMembers = null;
    delete _agoGroupMembers[g.id];
    await agoToggleMembers();
    agoLoadChannel().catch(console.error);   // refresh mention chips
    if (picked && !picked.live) {
      toast(`${picked.name} joined, but it's offline right now — it will answer once its connection is live.`,
        { variant: "warn" });
    } else if (picked) {
      toast(`${picked.name} added — it will answer messages here.`, { variant: "ok" });
    }
  } catch (e) { agoErr("Couldn't add agent", e); }
}
async function agoRemoveMember(type, id, channelId) {
  const g = agoSelGroup();
  if (!g) return;
  const qs = channelId ? `?channel_id=${encodeURIComponent(channelId)}` : "";
  try {
    await apiPost(
      `/api/groups/${encodeURIComponent(g.id)}/members/${encodeURIComponent(type)}/${encodeURIComponent(id)}${qs}`,
      {}, "DELETE");
    _agoMembers = null;
    delete _agoGroupMembers[g.id];
    await agoToggleMembers();
    agoLoadChannel().catch(console.error);
  } catch (e) { agoErr("Couldn't remove member", e); }
}

/* ---------- websocket ---------- */
function agoConnectWs() {
  if (_agoWs && (_agoWs.readyState === WebSocket.OPEN || _agoWs.readyState === WebSocket.CONNECTING)) return;
  const token = sessionToken();
  if (!token) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  try {
    _agoWs = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  } catch (e) { return; }
  _agoWs.onopen = () => { _agoWsBackoff = 1000; };
  _agoWs.onmessage = ev => {
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    agoHandleEvent(data);
  };
  _agoWs.onclose = () => {
    _agoWs = null;
    clearTimeout(_agoWsTimer);
    _agoWsTimer = setTimeout(agoConnectWs, _agoWsBackoff);
    _agoWsBackoff = Math.min(_agoWsBackoff * 2, 15000);
  };
}

function agoIngestMessage(m) {
  _agoLatestSeen[m.channel_id] = Math.max(_agoLatestSeen[m.channel_id] || 0, m.id);
  agoScheduleUnreadsRefresh();   // keep the unreads view live while it's open
  const channel = agoSelChannel();
  const open = !!(channel && m.channel_id === channel.id);
  const isThreadReply = m.thread_id != null;
  const mine = m.author_type === "user" && CURRENT_USER && m.author_id === CURRENT_USER.username;
  if (mine) {
    const u = _agoUnread[m.channel_id];
    if (u && !isThreadReply) u.last_read_id = Math.max(u.last_read_id, m.id);
    // Replying makes (or keeps) this thread ours — update the inbox.
    if (isThreadReply) agoBumpThreadUnread(m, true);
  } else {
    const boxId = isThreadReply ? "ago-thread-log" : "ago-log";
    const viewingThread = isThreadReply && _agoThreadRoot && _agoThreadRoot.id === m.thread_id;
    const inView = isThreadReply ? (open && viewingThread) : open;
    const box = inView ? document.getElementById(boxId) : null;
    const seenNow = inView && document.visibilityState === "visible"
      && document.hasFocus() && box && agoAtBottom(box);
    const u = _agoUnread[m.channel_id]
      || (_agoUnread[m.channel_id] = { count: 0, mentions: 0, last_read_id: 0 });
    if (!seenNow) {
      // Thread replies badge their thread (and the inbox), not the channel;
      // an @me anywhere still lights the channel's mention badge.
      if (!isThreadReply) u.count += 1;
      if (agoMentionsMe(m.text)) u.mentions = (u.mentions || 0) + 1;
      agoDrawSide();
      if (_agoGroupPage) agoDrawMain();   // keep the group page's badges live
      if (open && !isThreadReply) agoDrawUnreadBar();
    }
    if (isThreadReply) agoBumpThreadUnread(m, seenNow);
  }
  if (!open) return;
  if (m.thread_id == null) {
    if (!_agoMsgs.some(x => x.id === m.id)) {
      m.reply_count = m.reply_count || 0;
      _agoMsgs.push(m);
    }
    agoDrawMessages();
  } else {
    const inOpenThread = _agoThreadRoot && _agoThreadRoot.id === m.thread_id;
    if (inOpenThread) {
      if (_agoThreadMsgs.some(x => x.id === m.id)) return;
      _agoThreadMsgs.push(m);
      agoDrawThread();
    }
    const root = _agoMsgs.find(x => x.id === m.thread_id);
    if (root) {
      root.reply_count = (root.reply_count || 0) + 1;
      agoDrawMessages();
    }
    const pinnedRoot = _agoPins.find(x => x.id === m.thread_id);
    if (pinnedRoot) pinnedRoot.reply_count = (pinnedRoot.reply_count || 0) + 1;
  }
  if (m.author_type === "agent") {
    Object.keys(_agoProgress).forEach(h => {
      if (_agoProgress[h].agent_id === m.author_id) delete _agoProgress[h];
    });
    agoDrawStatus();
    agoLiveOnAgentMessage(m);   // live voice mode: speak the reply
    // Speak-aloud toggle: read the reply out unless a live session already
    // speaks for this channel.
    if (_agoSpeakAll && !agoLiveActive()) agoSpeakEnqueue(m.id);
  }
  // Thread replies don't ack the channel (that would clear a thread-mention
  // badge the user hasn't seen); the thread panel acks its own marker.
  if (!mine && !isThreadReply) agoMaybeMarkRead();
}

function agoApplyMessageUpdate(m) {
  if (!m || m.id == null) return;
  const channel = agoSelChannel();
  let redraw = false;
  const idx = _agoMsgs.findIndex(x => x.id === m.id);
  if (idx >= 0) {
    const prev = _agoMsgs[idx];
    _agoMsgs[idx] = { ...prev, ...m, reply_count: m.reply_count ?? prev.reply_count };
    redraw = !!(channel && m.channel_id === channel.id);
  }
  const tIdx = _agoThreadMsgs.findIndex(x => x.id === m.id);
  if (tIdx >= 0) {
    _agoThreadMsgs[tIdx] = { ..._agoThreadMsgs[tIdx], ...m };
    agoDrawThread();
  }
  if (redraw) agoDrawMessages();
}

function agoHandleEvent(data) {
  const channel = agoSelChannel();
  if (data.type === "message") { agoIngestMessage(data.message); return; }
  if (data.type === "message_update") {
    agoApplyMessageUpdate(data.message);
    return;
  }
  if (data.type === "read") { agoApplyRead(data.channel_id, data.last_read_id); return; }
  if (data.type === "thread_read") { agoApplyThreadRead(data.thread_id, data.last_read_id); return; }
  if (data.type === "thread_renamed") {
    const t = _agoThreads.find(x => x.root && x.root.id === data.thread_id);
    if (t && t.root) {
      t.root.alias = data.alias || null;
      agoDrawSide();
      if (_agoInboxOpen) agoDrawMain();
    }
    return;
  }
  if (!channel || data.channel_id !== channel.id) return;
  if (data.type === "pin") { agoApplyPin(data); return; }
  if (data.type === "typing") {
    if (data.active) _agoTyping[data.agent_id] = { name: data.agent_name, thread_id: data.thread_id };
    else {
      delete _agoTyping[data.agent_id];
      Object.keys(_agoProgress).forEach(h => {
        if (_agoProgress[h].agent_id === data.agent_id) delete _agoProgress[h];
      });
    }
    agoDrawStatus();
  } else if (data.type === "progress") {
    _agoProgress[data.handle] = {
      agent_id: data.agent_id, agent_name: data.agent_name,
      text: data.text, thread_id: data.thread_id,
    };
    agoDrawStatus();
  }
}

/* ====================================================================
   Voice features — ported from the Pantheo-embedded Agora page.
   Server side: POST /api/channels/{id}/voice (STT) and
   GET /api/messages/{id}/speech (TTS); both need OPENAI_API_KEY there.
   ==================================================================== */

/* ---------- voice input (🎙 in the composers) ----------
   Click 🎙 to record, click again to stop-and-send: the audio is uploaded to
   /voice, transcribed server-side, and posted as a normal text message (the
   same flow WhatsApp/Discord voice notes take). Nothing is stored as audio. */
let _agoRec = null;       // {key, threadId, recorder, stream, chunks, canceled, startedAt, timer}
let _agoRecBusy = null;   // composer key while an upload/transcription is in flight

function agoVoiceBtnHTML(threadId) {
  if (!_agoVoiceOK) return "";
  const key = agoRecKey(threadId);
  const arg = threadId != null ? threadId : "null";
  if (_agoRecBusy === key) {
    return `<button class="btn ago-mic busy" disabled title="Transcribing…">
      <span class="ago-rec-dots">…</span></button>`;
  }
  if (_agoRec && _agoRec.key === key) {
    return `<button class="btn ago-mic cancel" title="Discard recording"
        onclick="agoVoiceCancel()">${icon("x")}</button>
      <button class="btn ago-mic recording" title="Stop and send"
        onclick="agoVoiceToggle(${arg})">${icon("square", "fill")}&nbsp;<span class="ago-rec-time" id="ago-rec-time-${key}">0:00</span></button>`;
  }
  return `<button class="btn ago-mic" title="Record a voice message"
      onclick="agoVoiceToggle(${arg})">${icon("mic")}</button>`;
}

function agoRecMime() {
  // Chrome/Firefox record webm/opus; Safari records mp4 (AAC). Both are
  // accepted by the transcription API.
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function agoVoiceToggle(threadId) {
  if (_agoRec && _agoRec.key === agoRecKey(threadId)) { agoVoiceFinish(true); return; }
  if (_agoRec) agoVoiceFinish(false);   // one recording at a time
  await agoVoiceStart(threadId);
}

async function agoVoiceStart(threadId) {
  if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
    toast("Voice input isn't supported in this browser", { variant: "warn" });
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("Microphone blocked — allow mic access to send voice messages", { variant: "warn" });
    return;
  }
  const mime = agoRecMime();
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const rec = {
    key: agoRecKey(threadId), threadId, recorder, stream,
    chunks: [], canceled: false, startedAt: Date.now(), timer: null,
  };
  recorder.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  recorder.onstop = () => {
    clearInterval(rec.timer);
    stream.getTracks().forEach(t => t.stop());
    if (_agoRec === rec) _agoRec = null;
    if (!rec.canceled && rec.chunks.length) agoVoiceUpload(rec);
    else agoRedrawComposer(rec.threadId);
  };
  _agoRec = rec;
  recorder.start();
  rec.timer = setInterval(() => {
    const el = document.getElementById("ago-rec-time-" + rec.key);
    if (!el) return;
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    el.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }, 250);
  agoRedrawComposer(threadId);
}

function agoVoiceFinish(send) {
  if (!_agoRec) return;
  _agoRec.canceled = !send;
  try { _agoRec.recorder.stop(); } catch (e) { _agoRec = null; }
}
function agoVoiceCancel() { agoVoiceFinish(false); }

async function agoVoiceUpload(rec) {
  const channel = agoSelChannel();
  if (!channel) return;
  const type = (rec.recorder.mimeType || "audio/webm").toLowerCase();
  // The transcription API infers the codec from the file extension.
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const blob = new Blob(rec.chunks, { type });
  _agoRecBusy = rec.key;
  agoRedrawComposer(rec.threadId);
  try {
    const fd = new FormData();
    fd.append("file", blob, "voice-note." + ext);
    if (rec.threadId != null) fd.append("thread_id", rec.threadId);
    // FormData sets its own multipart boundary — only add the auth header.
    const res = await fetch(`/api/channels/${encodeURIComponent(channel.id)}/voice`, {
      method: "POST", headers: authHeaders(), body: fd,
    });
    if (!res.ok) {
      let detail = await res.text();
      try { detail = JSON.parse(detail).detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    agoIngestMessage(await res.json());   // websocket will dedupe by id
  } catch (e) {
    agoErr("Voice message failed", e);
  } finally {
    _agoRecBusy = null;
    agoRedrawComposer(rec.threadId);
  }
}

/* ---------- speak-aloud toggle (🔊 in the channel header) ----------
   A personal, page-level preference (localStorage, like the sidebar state):
   when on, agent replies arriving in whichever channel you're viewing are
   read aloud via /speech. Off by default; global across all groups/channels.
   The live voice mode below has its own playback — while a live session
   runs, this stays out of the way. */
let _agoSpeakAll = localStorage.getItem("agora_speak") === "on";
let _agoSpeakQueue = [];    // message ids waiting to be spoken
let _agoSpeakAudio = null;  // currently playing clip
let _agoSpeakWarned = false;
let _agoPlayWarned = false;   // autoplay blocked on mobile (one toast)
let _agoPlayer = null;        // reused for TTS — iOS needs playsInline + unlock

function agoPlayer() {
  if (!_agoPlayer) {
    _agoPlayer = new Audio();
    _agoPlayer.setAttribute("playsinline", "");
    _agoPlayer.playsInline = true;   // iOS: play in-page, not fullscreen
  }
  return _agoPlayer;
}

/* Mobile browsers (especially iOS Safari) block audio.play() unless the page
   has been "unlocked" by a recent user gesture. Mic/getUserMedia satisfies
   capture but not playback — call this from 🔊 / 🎧 Live taps. */
async function agoUnlockPlayback() {
  const p = agoPlayer();
  // Tiny silent WAV — just enough to satisfy the autoplay gate.
  p.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
  try {
    await p.play();
    p.pause();
    p.currentTime = 0;
    p.removeAttribute("src");
    p.load();
  } catch (e) { /* still try playback later */ }
  if (_agoLive && _agoLive.ac && _agoLive.ac.state === "suspended") {
    try { await _agoLive.ac.resume(); } catch (e) {}
  }
}

async function agoPlaySpeech(url, onDone) {
  const audio = agoPlayer();
  audio.onended = null;
  audio.onerror = null;
  audio.src = url;
  const done = () => { audio.onended = null; audio.onerror = null; onDone(); };
  audio.onended = done;
  audio.onerror = done;
  try {
    await audio.play();
    return audio;
  } catch (e) {
    if (!_agoPlayWarned) {
      _agoPlayWarned = true;
      toast("Couldn't play the reply — tap the speaker or Live button again to allow sound on this device",
        { variant: "warn" });
    }
    done();
    return null;
  }
}

// The flag is cached per tab, so without this a second open tab would keep
// speaking after the toggle was turned off elsewhere (and vice versa).
window.addEventListener("storage", e => {
  if (e.key !== "agora_speak") return;
  _agoSpeakAll = e.newValue === "on";
  if (!_agoSpeakAll) {
    agoSpeakStop();
    if (_agoLive) agoLiveStopPlayback(_agoLive);
  }
  agoDrawMain();
});

function agoSpeakToggle() {
  _agoSpeakAll = !_agoSpeakAll;
  localStorage.setItem("agora_speak", _agoSpeakAll ? "on" : "off");
  if (_agoSpeakAll) agoUnlockPlayback();   // mobile: unlock before the async reply
  if (!_agoSpeakAll) {
    agoSpeakStop();
    // A live session's playback obeys the toggle too: mute mid-sentence.
    if (_agoLive) agoLiveStopPlayback(_agoLive);
  }
  agoDrawMain();
}

function agoSpeakStop() {
  _agoSpeakQueue = [];
  const audio = _agoSpeakAudio || (_agoPlayer && !_agoPlayer.paused ? _agoPlayer : null);
  _agoSpeakAudio = null;
  if (!audio) return;
  audio.onended = null;
  audio.onerror = null;
  try { audio.pause(); } catch (e) {}
  if (audio.src && audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
}

function agoSpeakEnqueue(messageId) {
  _agoSpeakQueue.push(messageId);
  if (!_agoSpeakAudio) agoSpeakNext();
}

async function agoSpeakNext() {
  const id = _agoSpeakQueue.shift();
  if (id == null || !_agoSpeakAll) { _agoSpeakAudio = null; return; }
  let url;
  try {
    const res = await fetch(`/api/messages/${id}/speech`, { headers: authHeaders() });
    if (!res.ok) {
      // Surface "TTS not configured" once instead of failing silently forever.
      if (res.status === 400 && !_agoSpeakWarned) {
        _agoSpeakWarned = true;
        let detail = await res.text();
        try { detail = JSON.parse(detail).detail || detail; } catch (e) {}
        toast("Can't speak replies: " + detail, { variant: "warn" });
      }
      agoSpeakNext();
      return;
    }
    url = URL.createObjectURL(await res.blob());
  } catch (e) { agoSpeakNext(); return; }
  const done = () => {
    URL.revokeObjectURL(url);
    _agoSpeakAudio = null;
    agoSpeakNext();
  };
  const playing = await agoPlaySpeech(url, done);
  if (playing) _agoSpeakAudio = playing;
  else done();
}

/* ---------- live voice mode (hands-free two-way conversation) ----------
   A browser-side cascade: WebAudio VAD endpoints each utterance (speech
   starts above an RMS threshold, ends after a silence gap), the clip goes to
   /voice?live=true, and agent replies come back as normal messages that get
   auto-spoken via /speech. Speaking while the agent audio plays interrupts
   it (barge-in). The browser's echo cancellation keeps the agent's own
   voice out of the mic. */
const AGO_LIVE = {
  TICK_MS: 50,            // VAD poll interval
  SILENCE_MS: 800,        // utterance ends after this much quiet
  MIN_UTTER_MS: 300,      // shorter blips are coughs/key clicks — dropped
  BARGE_MS: 150,          // sustained speech during playback interrupts it
  THRESHOLD: 0.015,       // RMS speech threshold on the mic signal
  TURN_TIMEOUT_MS: 60000, // stop waiting for an agent reply after this long
};
const AGO_LIVE_LABELS = {
  listening: "Listening — just talk",
  recording: "Recording…",
  thinking: "Thinking…",
  speaking: "Speaking — talk to interrupt",
};
function agoLiveLabel(state) {
  // With 🔊 off the session still listens and posts turns, but replies stay
  // text-only — say so instead of implying audio is coming.
  if (state === "listening" && !_agoSpeakAll) {
    return "Listening — replies appear in chat (speaker off)";
  }
  return AGO_LIVE_LABELS[state] || state;
}
let _agoLive = null;   // active session (one per instance, tied to a channel
                       // or, when started from the thread panel, to one thread)

function agoLiveActive() {
  const c = agoSelChannel();
  return !!(_agoLive && c && _agoLive.channelId === c.id);
}

/* Is the session bound to this exact composer scope (null = the channel,
   a root id = that thread)? Drives the toggle states and strip placement. */
function agoLiveScopeActive(threadId) {
  return agoLiveActive() && _agoLive.threadId === (threadId != null ? threadId : null);
}

function agoLiveStripHTML(threadId) {
  if (!agoLiveScopeActive(threadId)) return "";
  const s = _agoLive.state;
  const arg = threadId != null ? threadId : "null";
  return `<div class="ago-live-strip st-${s}" id="ago-live-strip">
    <span class="ago-live-dot"></span>
    <span class="ago-live-label">${agoLiveLabel(s)}</span>
    <button class="btn sm" onclick="agoLiveToggle(${arg})">End</button>
  </div>`;
}

function agoLiveSetState(live, state) {
  if (live.state === state) return;
  live.state = state;
  const el = document.getElementById("ago-live-strip");
  if (!el) return;
  el.className = "ago-live-strip st-" + state;
  const label = el.querySelector(".ago-live-label");
  if (label) label.textContent = agoLiveLabel(state);
}

async function agoLiveToggle(threadId) {
  threadId = threadId != null ? threadId : null;
  if (_agoLive) {
    const same = agoLiveScopeActive(threadId);
    agoLiveStop();
    if (same) return;   // same button: plain stop. Other scope: restart there.
  }
  const channel = agoSelChannel();
  if (!channel) return;
  if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
    toast("Live voice isn't supported in this browser", { variant: "warn" });
    return;
  }
  if (_agoRec) agoVoiceCancel();   // the live loop owns the mic
  let stream;
  try {
    // Echo cancellation is load-bearing: without it the agent's own playback
    // re-triggers the endpointer and the session talks to itself.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    toast("Microphone blocked — allow mic access for live voice", { variant: "warn" });
    return;
  }
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(analyser);
  _agoLive = {
    channelId: channel.id, threadId, stream, ac, analyser,
    buf: new Float32Array(analyser.fftSize),
    state: "listening", timer: null,
    recorder: null, chunks: [], utterStart: 0, lastVoice: 0,
    voicedMs: 0,                              // consecutive voiced ms during playback
    turnBusy: false, turnTimer: null, queue: [],
    playQueue: [], audio: null,
  };
  _agoLive.timer = setInterval(agoLiveTick, AGO_LIVE.TICK_MS);
  agoDrawMain();
  agoDrawThread();   // thread-scoped sessions render their strip in the panel
  // Playback unlock + AudioContext resume, deliberately not awaited: the
  // play() promise of the unlock clip can stay pending forever in some
  // webviews (Tauri/WKWebView), and the strip must render immediately.
  agoUnlockPlayback();
}

function agoLiveStop() {
  const live = _agoLive;
  if (!live) return;
  _agoLive = null;
  clearInterval(live.timer);
  clearTimeout(live.turnTimer);
  const rec = live.recorder;
  if (rec) {
    rec.ondataavailable = null;
    rec.onstop = null;
    try { rec.stop(); } catch (e) {}
  }
  agoLiveStopPlayback(live);
  live.stream.getTracks().forEach(t => t.stop());
  try { live.ac.close(); } catch (e) {}
  agoDrawMain();
  agoDrawThread();
}

function agoLiveRms(live) {
  live.analyser.getFloatTimeDomainData(live.buf);
  let sum = 0;
  for (let i = 0; i < live.buf.length; i++) sum += live.buf[i] * live.buf[i];
  return Math.sqrt(sum / live.buf.length);
}

function agoLiveTick() {
  const live = _agoLive;
  if (!live) return;
  const now = Date.now();
  const voiced = agoLiveRms(live) >= AGO_LIVE.THRESHOLD;

  // Barge-in: sustained speech while agent audio plays cancels the playback
  // queue and starts capturing the interruption as a fresh utterance.
  if (live.audio) {
    live.voicedMs = voiced ? live.voicedMs + AGO_LIVE.TICK_MS : 0;
    if (live.voicedMs >= AGO_LIVE.BARGE_MS) {
      live.voicedMs = 0;
      agoLiveStopPlayback(live);
      agoLiveBeginUtterance(live, now);
      return;
    }
    agoLiveSetState(live, "speaking");
    return;
  }

  if (!live.recorder) {
    if (voiced) agoLiveBeginUtterance(live, now);
    else agoLiveSetState(live, live.turnBusy ? "thinking" : "listening");
    return;
  }
  if (voiced) live.lastVoice = now;
  if (now - live.lastVoice >= AGO_LIVE.SILENCE_MS) agoLiveEndUtterance(live);
  else agoLiveSetState(live, "recording");
}

function agoLiveBeginUtterance(live, now) {
  if (live.recorder) return;
  const mime = agoRecMime();
  let recorder;
  try {
    recorder = mime
      ? new MediaRecorder(live.stream, { mimeType: mime })
      : new MediaRecorder(live.stream);
  } catch (e) {
    agoErr("Live voice recording failed", e);
    agoLiveStop();
    return;
  }
  live.chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) live.chunks.push(e.data); };
  recorder.onstop = () => {
    const ms = live.lastVoice - live.utterStart;
    const chunks = live.chunks;
    live.recorder = null;
    live.chunks = [];
    if (_agoLive !== live) return;   // session ended while recording
    if (ms < AGO_LIVE.MIN_UTTER_MS || !chunks.length) return;   // noise blip
    live.queue.push(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    agoLivePump(live);
  };
  live.recorder = recorder;
  live.utterStart = now;
  live.lastVoice = now;
  recorder.start();
  agoLiveSetState(live, "recording");
}

function agoLiveEndUtterance(live) {
  const rec = live.recorder;
  if (!rec) return;
  try { rec.stop(); } catch (e) { live.recorder = null; }
}

/* One turn in flight at a time: utterances spoken while the agent is
   thinking queue up and post sequentially. */
async function agoLivePump(live) {
  if (_agoLive !== live || live.turnBusy || !live.queue.length) return;
  live.turnBusy = true;
  agoLiveSetState(live, "thinking");
  clearTimeout(live.turnTimer);
  // Safety valve: a channel with no live agents (or a dropped reply) must not
  // wedge the session in "thinking" forever.
  live.turnTimer = setTimeout(() => {
    live.turnBusy = false;
    agoLivePump(live);
  }, AGO_LIVE.TURN_TIMEOUT_MS);
  const blob = live.queue.shift();
  const type = (blob.type || "audio/webm").toLowerCase();
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  try {
    const fd = new FormData();
    fd.append("file", blob, "utterance." + ext);
    fd.append("live", "true");
    if (live.threadId != null) fd.append("thread_id", live.threadId);
    const res = await fetch(`/api/channels/${encodeURIComponent(live.channelId)}/voice`, {
      method: "POST", headers: authHeaders(), body: fd,
    });
    if (!res.ok) {
      let detail = await res.text();
      try { detail = JSON.parse(detail).detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    agoIngestMessage(await res.json());   // websocket will dedupe by id
  } catch (e) {
    // Inaudible clips (breath, rustle) are routine in a hands-free loop —
    // resume listening quietly instead of toasting an error.
    if (!/couldn't hear/i.test((e && e.message) || "")) agoErr("Voice turn failed", e);
    clearTimeout(live.turnTimer);
    live.turnBusy = false;
    agoLivePump(live);
  }
}

/* An agent reply landed in the live channel: close the pending turn and
   speak it — unless the 🔊 speak-aloud toggle is off, in which case the
   reply stays text-only in the chat and the loop goes straight back to
   listening. Called from agoIngestMessage. */
function agoLiveOnAgentMessage(m) {
  const live = _agoLive;
  if (!live || m.channel_id !== live.channelId) return;
  // Only replies in the session's scope close the turn and get spoken:
  // channel sessions take top-level replies, thread sessions their thread's.
  if ((m.thread_id != null ? m.thread_id : null) !== live.threadId) return;
  clearTimeout(live.turnTimer);
  live.turnBusy = false;
  if (_agoSpeakAll) {
    live.playQueue.push(m.id);
    if (!live.audio) agoLivePlayNext(live);
  } else {
    agoLiveSetState(live, "listening");
  }
  agoLivePump(live);
}

async function agoLivePlayNext(live) {
  if (_agoLive !== live) return;
  const id = live.playQueue.shift();
  if (id == null) {
    live.audio = null;
    agoLiveSetState(live, live.turnBusy ? "thinking" : "listening");
    return;
  }
  let url;
  try {
    const res = await fetch(`/api/messages/${id}/speech`, { headers: authHeaders() });
    if (!res.ok) throw new Error(await res.text());
    url = URL.createObjectURL(await res.blob());
  } catch (e) {
    agoLivePlayNext(live);   // unspeakable message — keep the queue moving
    return;
  }
  if (_agoLive !== live) { URL.revokeObjectURL(url); return; }
  live.voicedMs = 0;
  agoLiveSetState(live, "speaking");
  const done = () => {
    URL.revokeObjectURL(url);
    if (live.audio) { live.audio = null; agoLivePlayNext(live); }
  };
  live.audio = await agoPlaySpeech(url, done);
  if (!live.audio) done();
}

function agoLiveStopPlayback(live) {
  live.playQueue = [];
  const audio = live.audio || (_agoPlayer && !_agoPlayer.paused ? _agoPlayer : null);
  live.audio = null;
  if (!audio) return;
  audio.onended = null;
  audio.onerror = null;
  try { audio.pause(); } catch (e) {}
  if (audio.src && audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
}

/* ====================================================================
   Search — Cmd/Ctrl-K overlay over GET /api/search, keyboard-driven.
   When the server has an ANTHROPIC_API_KEY (/api/me → search_ai) a
   pinned "Ask Agora AI" row answers via POST /api/search/ask.
   ==================================================================== */
const AGO_SEARCH_KEY =
  /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘K" : "Ctrl+K";
let _agoSearchAI = false;        // /api/me said search_ai: offer the Ask row
let _agoSearchOpen = false;
let _agoSearchQ = "";            // query the current results belong to
let _agoSearchRes = null;        // /api/search response (+ .error) or null
let _agoSearchTimer = null;      // input debounce
let _agoSearchSeq = 0;           // drop out-of-order search responses
let _agoSearchSel = 0;           // selected index into _agoSearchItems
let _agoSearchItems = [];        // flat activation list, rebuilt on each draw
let _agoSearchView = "results";  // "results" | "ask"
let _agoSearchAnswer = null;     // /ask response, or "loading"
let _agoSearchMoreBusy = false;  // "More results" page in flight
let _agoSearchScope = "";        // "" | "g:<group_id>" | "c:<channel_id>"

function agoSearchEnsure() {
  if (document.getElementById("ago-search-overlay")) return;
  const el = document.createElement("div");
  el.className = "ago-search-overlay";
  el.id = "ago-search-overlay";
  el.style.display = "none";
  el.onclick = e => { if (e.target === el) agoSearchClose(); };
  el.innerHTML = `
    <div class="ago-search-panel">
      <div class="ago-search-bar">
        ${icon("search")}
        <input id="ago-search-input" placeholder="Search messages, channels, groups…"
          autocomplete="off" autocapitalize="off" spellcheck="false"
          oninput="agoSearchInput()">
        <select id="ago-search-scope" class="ago-search-scope" title="Search scope"
          onchange="agoSearchScopeChange()"></select>
        <button class="ago-x" title="Close (Esc)" onclick="agoSearchClose()">${icon("x")}</button>
      </div>
      <div class="ago-search-body" id="ago-search-body"></div>
    </div>`;
  document.body.appendChild(el);
}

/* Rebuild the scope <select> from _agoGroups (groups may have changed since
   the palette last opened). Keeps the current selection when it still exists;
   a scope pointing at a deleted group/channel falls back to Everywhere. */
function agoSearchScopeFill() {
  const sel = document.getElementById("ago-search-scope");
  if (!sel) return;
  let html = `<option value="">Everywhere</option>`;
  for (const g of _agoGroups) {
    html += `<optgroup label="${esc(g.name)}">
      <option value="g:${esc(String(g.id))}">All of ${esc(g.name)}</option>`;
    for (const c of (g.channels || [])) {
      html += `<option value="c:${esc(String(c.id))}"># ${esc(c.name)}</option>`;
    }
    html += `</optgroup>`;
  }
  sel.innerHTML = html;
  sel.value = _agoSearchScope;
  if (sel.value !== _agoSearchScope) { _agoSearchScope = ""; sel.value = ""; }
}

/* "&group_id=…" / "&channel_id=…" for the GET endpoints, "" when unscoped. */
function agoSearchScopeParam() {
  const s = _agoSearchScope;
  if (s.startsWith("g:")) return `&group_id=${encodeURIComponent(s.slice(2))}`;
  if (s.startsWith("c:")) return `&channel_id=${encodeURIComponent(s.slice(2))}`;
  return "";
}

/* Human name of the active scope for the empty state ("" when unscoped
   or the scoped group/channel no longer exists in _agoGroups). */
function agoSearchScopeName() {
  const s = _agoSearchScope;
  if (!s) return "";
  for (const g of _agoGroups) {
    if (s === "g:" + g.id) return g.name;
    for (const c of (g.channels || [])) {
      if (s === "c:" + c.id) return "#" + c.name;
    }
  }
  return "";
}

function agoSearchScopeChange() {
  const sel = document.getElementById("ago-search-scope");
  _agoSearchScope = (sel && sel.value) || "";
  clearTimeout(_agoSearchTimer);
  _agoSearchRes = null;   // same q, new scope: force the re-fetch
  const input = document.getElementById("ago-search-input");
  const q = ((input && input.value) || "").trim();
  agoSearchRun(q).catch(console.error);
  if (input) input.focus();
}

function agoSearchShow() {
  if (document.getElementById("auth-gate")) return;
  agoSearchEnsure();
  agoSearchScopeFill();
  _agoSearchOpen = true;
  document.getElementById("ago-search-overlay").style.display = "";
  // An /ask abandoned mid-flight must not reopen as an eternal spinner.
  if (_agoSearchAnswer === "loading") { _agoSearchView = "results"; _agoSearchAnswer = null; }
  agoSearchDraw();
  // The last query stays, selected, so typing replaces it and Enter re-runs it.
  const input = document.getElementById("ago-search-input");
  input.focus();
  input.select();
}

function agoSearchClose() {
  _agoSearchOpen = false;
  clearTimeout(_agoSearchTimer);
  const el = document.getElementById("ago-search-overlay");
  if (el) el.style.display = "none";
}

function agoSearchToggle() {
  if (_agoSearchOpen) agoSearchClose(); else agoSearchShow();
}

/* Global shortcuts. Escape is only claimed while the overlay is open, so
   the composers' own Escape handling keeps working. */
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
      && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    agoSearchToggle();
    return;
  }
  if (!_agoSearchOpen) return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (_agoSearchView === "ask") agoSearchBack(); else agoSearchClose();
    return;
  }
  if (e.isComposing) return;
  // Arrows/Enter inside the scope <select> belong to the select itself.
  if (e.target && e.target.id === "ago-search-scope") return;
  if (e.key === "ArrowDown") { e.preventDefault(); agoSearchMove(1); return; }
  if (e.key === "ArrowUp") { e.preventDefault(); agoSearchMove(-1); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    // Enter inside the debounce window searches what's typed, not stale rows.
    const input = document.getElementById("ago-search-input");
    const q = ((input && input.value) || "").trim();
    if (_agoSearchView === "results" && q !== _agoSearchQ) {
      clearTimeout(_agoSearchTimer);
      agoSearchRun(q).catch(console.error);
      return;
    }
    agoSearchActivate(_agoSearchSel);
  }
});

function agoSearchInput() {
  const input = document.getElementById("ago-search-input");
  const q = ((input && input.value) || "").trim();
  clearTimeout(_agoSearchTimer);
  _agoSearchTimer = setTimeout(() => { agoSearchRun(q).catch(console.error); }, 250);
}

async function agoSearchRun(q) {
  _agoSearchView = "results";
  _agoSearchAnswer = null;
  if (q === _agoSearchQ && _agoSearchRes) { agoSearchDraw(); return; }
  _agoSearchQ = q;
  _agoSearchSel = 0;
  _agoSearchRes = null;
  agoSearchDraw();   // ask row + "Searching…" show while the fetch runs
  if (!q) return;
  const seq = ++_agoSearchSeq;
  let res;
  try {
    res = await api(`/api/search?q=${encodeURIComponent(q)}${agoSearchScopeParam()}`);
  } catch (e) {
    res = { error: (e && e.message) || String(e) };
  }
  if (seq !== _agoSearchSeq || !_agoSearchOpen) return;
  _agoSearchRes = res;
  _agoSearchSel = 0;
  agoSearchDraw();
}

/* Matched terms arrive wrapped in U+0001 … U+0002 — escape first, then turn
   the markers into the highlight span (so server text can't inject HTML). */
function agoSearchSnippetHTML(s) {
  return esc(s)
    .replace(/\u0001/g, '<span class="ago-search-hl">')
    .replace(/\u0002/g, "</span>");
}

function agoSearchMsgRowHTML(m, i, num) {
  const crumb = `${m.group_name || ""} / #${m.channel_name || ""}`;
  const snippet = m.snippet != null
    ? agoSearchSnippetHTML(m.snippet) : esc(agoPinSnippet(m));
  return `
    <div class="ago-search-row msg" data-si="${i}" title="Jump to message"
         onclick="agoSearchActivate(${i})">
      <div class="ago-search-msg-top">
        ${num ? `<span class="ago-search-srcn">${num}</span>` : ""}
        <span class="ago-search-author">${esc(agoAuthorLabel(m))}</span>
        <span class="ago-search-crumb">${esc(crumb)}${m.thread_id != null ? " · in thread" : ""}</span>
        <span class="ago-search-ts">${esc(fmtTs(m.ts))}</span>
      </div>
      <div class="ago-search-snippet">${snippet}</div>
    </div>`;
}

function agoSearchDraw() {
  const box = document.getElementById("ago-search-body");
  if (!box) return;
  _agoSearchItems = [];
  if (_agoSearchView === "ask") { agoSearchDrawAsk(box); return; }
  const q = _agoSearchQ;
  if (!q) {
    box.innerHTML = `<div class="ago-search-hint">
      Search messages, channels, and groups${_agoSearchAI ? " — or ask the AI a question" : ""}.</div>`;
    return;
  }
  let html = "";
  if (_agoSearchAI) {
    const i = _agoSearchItems.push({ kind: "ask" }) - 1;
    html += `
      <div class="ago-search-row ask" data-si="${i}" onclick="agoSearchActivate(${i})"
           title="Answer this from your message history">
        <span class="ago-search-spark">${icon("sparkles")}</span>
        <span class="ago-search-ask-label">Ask Agora AI: <b>“${esc(q)}”</b></span>
      </div>`;
  }
  const res = _agoSearchRes;
  const groups = (res && res.groups) || [];
  const channels = (res && res.channels) || [];
  const msgs = (res && res.messages && res.messages.items) || [];
  if (groups.length) {
    html += `<div class="ago-search-label">Groups</div>`;
    for (const g of groups) {
      const i = _agoSearchItems.push({ kind: "group", g }) - 1;
      html += `
      <div class="ago-search-row" data-si="${i}" onclick="agoSearchActivate(${i})"
           title="Open ${esc(g.name)}">
        <span class="ago-search-ico">${icon("layout-grid")}</span>
        <span class="ago-search-name">${esc(g.name)}</span>
        ${g.description ? `<span class="ago-search-sub">${esc(g.description)}</span>` : ""}
      </div>`;
    }
  }
  if (channels.length) {
    html += `<div class="ago-search-label">Channels</div>`;
    for (const c of channels) {
      const i = _agoSearchItems.push({ kind: "channel", c }) - 1;
      html += `
      <div class="ago-search-row" data-si="${i}" onclick="agoSearchActivate(${i})"
           title="Open #${esc(c.name)}">
        <span class="ago-search-ico hash">#</span>
        <span class="ago-search-name">${esc(c.name)}</span>
        <span class="ago-search-crumb">${esc(c.group_name || "")}</span>
        ${c.topic ? `<span class="ago-search-sub">${esc(c.topic)}</span>` : ""}
      </div>`;
    }
  }
  if (msgs.length) {
    html += `<div class="ago-search-label">Messages</div>`;
    html += msgs.map(m =>
      agoSearchMsgRowHTML(m, _agoSearchItems.push({ kind: "message", m }) - 1, 0)).join("");
    if (res.messages.has_more) {
      const i = _agoSearchItems.push({ kind: "more" }) - 1;
      html += `
      <div class="ago-search-row more" data-si="${i}" onclick="agoSearchActivate(${i})">
        ${_agoSearchMoreBusy ? icon("loader", "spin") + " Loading…" : "More results"}
      </div>`;
    }
  }
  if (res && res.error) {
    html += `<div class="ago-search-hint">Search failed: ${esc(res.error)}</div>`;
  } else if (!res) {
    html += `<div class="ago-search-hint">Searching…</div>`;
  } else if (!groups.length && !channels.length && !msgs.length) {
    const sn = agoSearchScopeName();
    html += `<div class="ago-search-hint">No results for “${esc(q)}”${sn ? ` in ${esc(sn)}` : ""}</div>`;
  }
  if (_agoSearchSel >= _agoSearchItems.length) {
    _agoSearchSel = Math.max(0, _agoSearchItems.length - 1);
  }
  box.innerHTML = html;
  agoSearchApplySel();
}

function agoSearchMove(d) {
  const n = _agoSearchItems.length;
  if (!n) return;
  _agoSearchSel = (_agoSearchSel + d + n) % n;
  agoSearchApplySel();
}

function agoSearchApplySel() {
  const box = document.getElementById("ago-search-body");
  if (!box) return;
  box.querySelectorAll(".ago-search-row").forEach(el => {
    el.classList.toggle("sel", Number(el.dataset.si) === _agoSearchSel);
  });
  const el = box.querySelector(`.ago-search-row[data-si="${_agoSearchSel}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

function agoSearchActivate(i) {
  const it = _agoSearchItems[i];
  if (!it) return;
  _agoSearchSel = i;
  if (it.kind === "ask") { agoSearchAsk().catch(console.error); return; }
  if (it.kind === "more") { agoSearchMore().catch(console.error); return; }
  if (it.kind === "group") {
    agoSearchClose();
    agoOpenGroupPage(it.g.id);
    return;
  }
  if (it.kind === "channel") {
    agoSearchClose();
    agoSelectChannel(it.c.group_id, it.c.id);
    return;
  }
  // message (results or Ask-AI sources)
  const m = it.m;
  agoSearchClose();
  agoJumpToMessage(m.group_id, m.channel_id, m.thread_id, m.id).catch(console.error);
}

async function agoSearchMore() {
  const res = _agoSearchRes;
  if (!res || !res.messages || !res.messages.has_more || _agoSearchMoreBusy) return;
  _agoSearchMoreBusy = true;
  agoSearchDraw();
  const q = _agoSearchQ;
  const offset = (res.messages.items || []).length;
  try {
    const data = await api(
      `/api/search?q=${encodeURIComponent(q)}&types=messages&offset=${offset}${agoSearchScopeParam()}`);
    if (q !== _agoSearchQ || _agoSearchRes !== res) return;   // query moved on
    const page = data.messages || {};
    res.messages.items = (res.messages.items || []).concat(page.items || []);
    res.messages.has_more = !!page.has_more;
  } catch (e) {
    agoErr("Couldn't load more results", e);
  } finally {
    _agoSearchMoreBusy = false;
    agoSearchDraw();
  }
}

/* ---------- Ask AI (answer view) ---------- */
async function agoSearchAsk() {
  const q = _agoSearchQ;
  if (!q) return;
  _agoSearchView = "ask";
  _agoSearchAnswer = "loading";
  _agoSearchSel = 0;
  agoSearchDraw();
  let data;
  try {
    const body = { q };
    if (_agoSearchScope.startsWith("g:")) body.group_id = _agoSearchScope.slice(2);
    else if (_agoSearchScope.startsWith("c:")) body.channel_id = _agoSearchScope.slice(2);
    data = await apiPost("/api/search/ask", body);
  } catch (e) {
    if (!_agoSearchOpen || _agoSearchView !== "ask") return;
    agoErr("Ask AI failed", e);
    agoSearchBack();
    return;
  }
  if (!_agoSearchOpen || _agoSearchView !== "ask" || q !== _agoSearchQ) return;
  _agoSearchAnswer = data;
  agoSearchDraw();
}

function agoSearchBack() {
  _agoSearchView = "results";
  _agoSearchAnswer = null;
  _agoSearchSel = 0;
  agoSearchDraw();
  const input = document.getElementById("ago-search-input");
  if (input) input.focus();
}

/* [n] citations become superscript links to sources[n-1]; the same
   pre/code/link split as agoMd keeps code blocks untouched. */
function agoSearchAnswerHTML(answer, nSources) {
  return agoMd(answer)
    .split(/(<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>)/)
    .map((seg, i) => i % 2 ? seg : seg.replace(/\[(\d{1,2})\]/g, (all, n) => {
      n = Number(n);
      if (n < 1 || n > nSources) return all;
      return `<sup class="ago-search-cite"><a href="#" title="Jump to source ${n}"
        onclick="event.preventDefault(); agoSearchCiteJump(${n})">[${n}]</a></sup>`;
    }))
    .join("");
}

function agoSearchCiteJump(n) {
  const a = _agoSearchAnswer;
  const src = a && a.sources && a.sources[n - 1];
  if (!src) return;
  agoSearchClose();
  agoJumpToMessage(src.group_id, src.channel_id, src.thread_id, src.id).catch(console.error);
}

function agoSearchDrawAsk(box) {
  const a = _agoSearchAnswer;
  let body;
  if (!a || a === "loading") {
    body = `<div class="ago-search-thinking">${icon("loader", "spin")} Thinking…</div>`;
  } else if (!a.answer) {
    body = `<div class="ago-search-hint">${esc(a.detail || "No answer.")}</div>`;
  } else {
    const sources = a.sources || [];
    const srcRows = sources.map((m, k) =>
      agoSearchMsgRowHTML(m, _agoSearchItems.push({ kind: "message", m }) - 1, k + 1)).join("");
    body = `
      <div class="ago-search-answer">${agoSearchAnswerHTML(a.answer, sources.length)}</div>
      ${sources.length ? `<div class="ago-search-label">Sources</div>${srcRows}` : ""}`;
  }
  box.innerHTML = `
    <div class="ago-search-askhead">
      <button class="btn sm" title="Back to results (Esc)"
        onclick="agoSearchBack()">${icon("chevron-left")} Results</button>
      <span class="ago-search-askq">${icon("sparkles")} ${esc(_agoSearchQ)}</span>
    </div>
    ${body}`;
  if (_agoSearchSel >= _agoSearchItems.length) {
    _agoSearchSel = Math.max(0, _agoSearchItems.length - 1);
  }
  agoSearchApplySel();
}
