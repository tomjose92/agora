/* Agora chat UI: groups, channels, threads, live via the /ws websocket.
   Ported from Pantheo's admin page; talks to the standalone app's /api.
   Voice/live/speak features from the original are stubbed out in v1 (they
   depended on the Pantheo server's STT/TTS). */

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
   snapshot drives the "New" divider and the jump-to-latest bar. */
let _agoUnread = {};            // channel_id -> {count, last_read_id}
let _agoLatestSeen = {};        // channel_id -> highest message id seen live
let _agoDividerAfter = null;    // marker snapshot: "New" renders after this id
let _agoDividerChan = null;     // channel the divider snapshot belongs to
let _agoLandOnDivider = false;  // next draw scrolls to the divider, not the bottom
let _agoReadTimer = null;       // debounce for PUT /read

/* Voice features are not in the standalone app (v1) — inert stubs keep the
   ported flow intact without the STT/TTS plumbing. */
const _agoSpeakAll = false;
function agoVoiceCancel() {}
function agoLiveStop() {}
function agoSpeakStop() {}
function agoLiveScopeActive() { return false; }
function agoLiveStripHTML() { return ""; }
function agoVoiceBtnHTML() { return ""; }
function agoLiveOnAgentMessage() {}
function agoSpeakEnqueue() {}
async function agoUnlockPlayback() {}
let _agoRec = null;

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
  agoSelectGroup(gid);
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

/* Agent avatar (bot emoji fallback; the standalone app has no avatars yet). */
function agoAgentAvatarHTML(agentId, cls) {
  const meta = _agoAvailAgents.find(a => a.id === agentId);
  const av = meta && meta.avatar;
  if (av) {
    return `<span class="ago-av ${cls || ""} has-avatar"><img src="${esc(av)}" alt=""
      onerror="this.parentElement.classList.remove('has-avatar');this.parentElement.textContent='🤖'"></span>`;
  }
  return `<span class="ago-av ${cls || ""}">🤖</span>`;
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
        last_read_id: c.last_read_id || 0,
      };
    }
  }
  if (_agoExpanded) {
    _agoExpanded = _agoExpanded.filter(id => _agoGroups.some(g => g.id === id));
  }
  if (!agoSelGroup()) {
    _agoSel.g = _agoGroups.length ? _agoGroups[0].id : null;
    _agoSel.c = null;
  }
  const g = agoSelGroup();
  if (g && !agoSelChannel()) _agoSel.c = (g.channels[0] || {}).id || null;
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
function agoGroupUnread(g) {
  return (g.channels || []).reduce((n, c) => n + agoUnreadCount(c.id), 0);
}
function agoBadgeHTML(n) {
  return n > 0 ? `<span class="ago-unread-badge">${n > 99 ? "99+" : n}</span>` : "";
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
  const u = _agoUnread[cid] || (_agoUnread[cid] = { count: 0, last_read_id: 0 });
  if (lastId < u.last_read_id) return;   // stale ack from a slow tab
  u.last_read_id = lastId;
  u.count = 0;
  agoDrawSide();
  agoDrawUnreadBar();
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
    <button class="lnk" onclick="agoJumpToLatest()">Jump to latest ↓</button>
    <button class="lnk dim" onclick="agoMarkReadNow()">Mark as read</button>`;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  agoMaybeMarkRead();
});
// Coming back to the window acks whatever is on screen (the counterpart of
// the hasFocus() guard above).
window.addEventListener("focus", () => { agoMaybeMarkRead(); });

/* ---------- sidebar (groups + channels) ---------- */
function agoDrawSide() {
  const box = document.getElementById("agora-side");
  if (!box) return;
  const groupRows = _agoGroups.map(g => {
    const open = agoIsExpanded(g.id);
    const sel = g.id === _agoSel.g;
    const groupUnread = agoGroupUnread(g);
    const channels = open ? (g.channels || []).map(c => {
      const armed = agoArmed("chan:" + c.id);
      const unread = agoUnreadCount(c.id);
      const del = (g.role === "admin" || isOwner())
        ? `<button class="ago-x ${armed ? "armed" : ""}" title="${armed ? "Click again to delete #" + esc(c.name) : "Delete channel"}"
             onclick="event.stopPropagation(); agoDeleteChannel('${esc(g.id)}','${esc(c.id)}')">${armed ? "Sure?" : "✕"}</button>`
        : "";
      return `
      <div class="ago-chan ${sel && c.id === _agoSel.c ? "active" : ""} ${unread ? "unread" : ""}"
           onclick="agoSelectChannel('${esc(g.id)}','${esc(c.id)}')">
        <span class="hash">#</span><span class="nm">${esc(c.name)}</span>
        ${agoBadgeHTML(unread)}
        ${del}
      </div>`;
    }).join("") : "";
    const addChan = open && (g.role === "admin" || isOwner())
      ? (_agoCreating === "channel" && _agoCreatingIn === g.id
        ? `<div class="ago-create"><input id="ago-new-channel" placeholder="channel name"
             onkeydown="if(event.key==='Enter')agoCreateChannel();if(event.key==='Escape')agoCancelCreate()">
           <button class="btn sm" onclick="agoCreateChannel()">Add</button></div>`
        : `<button class="ago-add" onclick="agoOpenCreate('channel','${esc(g.id)}')">+ channel</button>`)
      : "";
    return `<div class="ago-group ${open ? "open" : ""} ${sel ? "sel" : ""}">
      <div class="ago-group-head ${groupUnread ? "unread" : ""}" onclick="agoToggleGroup('${esc(g.id)}')"
           title="${open ? "Collapse" : "Expand"} ${esc(g.name)}">
        <span class="ago-caret ${open ? "open" : ""}">▸</span>
        <span class="nm">${esc(g.name)}</span>
        ${agoBadgeHTML(groupUnread)}
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
  const anyUnread = _agoGroups.some(g => agoGroupUnread(g) > 0);
  box.innerHTML = `<div class="side-title"><span>Groups</span>
      <button class="ago-side-toggle collapse" title="Collapse groups" onclick="agoToggleSide()">«</button></div>
    <button class="ago-side-toggle expand" title="Show groups" onclick="agoToggleSide()">»</button>
    ${anyUnread ? '<span class="ago-side-dot" title="Unread messages"></span>' : ""}
    <div class="ago-groups">${groupRows ||
      '<div class="dim" style="padding:10px 12px;font-size:12px">No groups yet — create one to start chatting.</div>'}</div>
    <div class="ago-side-foot">${addGroup}</div>`;
  const input = document.getElementById("ago-new-group") || document.getElementById("ago-new-channel");
  if (input) input.focus();
}

function agoSelectGroup(gid) {
  agoSetExpanded(gid, true);
  if (_agoSel.g !== gid) {
    _agoSel.g = gid;
    const g = agoSelGroup();
    _agoSel.c = (g && g.channels[0] && g.channels[0].id) || null;
    _agoThreadRoot = null; _agoThreadMsgs = []; _agoMembers = null;
    _agoPins = []; _agoPinsOpen = false;
    _agoStars = []; _agoStarsOpen = false;
    agoSaveSel();
  }
  _agoCreating = null;
  agoDisarm();
  agoDrawSide();
  agoLoadChannel().catch(console.error);
}
function agoSelectChannel(gid, cid) {
  agoSetExpanded(gid, true);
  if (_agoSel.c !== cid || _agoSel.g !== gid) {
    _agoFiles = {};     // pending attachments belong to the previous channel
    _agoSel.g = gid; _agoSel.c = cid;
    _agoThreadRoot = null; _agoThreadMsgs = []; _agoMembers = null;
    _agoPins = []; _agoPinsOpen = false;
    _agoStars = []; _agoStarsOpen = false;
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
    agoSetExpanded(group.id, true);
    _agoSel.g = group.id; _agoSel.c = null;
    agoSaveSel();
    agoDrawSide();
    agoLoadChannel().catch(console.error);
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
async function agoDeleteGroup() {
  const g = agoSelGroup();
  if (!g) return;
  if (!agoArmed("group:" + g.id)) { agoArm("group:" + g.id, agoDrawMain); return; }
  agoDisarm();
  try {
    await apiPost(`/api/groups/${encodeURIComponent(g.id)}`, {}, "DELETE");
    _agoSel = {};
    _agoMembers = null;
    agoSaveSel();
    await agoLoadGroups();
    agoDrawSide();
    agoLoadChannel().catch(console.error);
    toast(`Group "${g.name}" deleted`, { variant: "ok" });
  } catch (e) { agoErr("Delete failed", e); agoDrawMain(); }
}

/* ---------- main column (messages + composer) ---------- */
function agoDrawMain() {
  const box = document.getElementById("agora-main");
  if (!box) return;
  const group = agoSelGroup();
  const channel = agoSelChannel();
  if (!channel) {
    box.innerHTML = `
      <div class="ago-head ago-head-empty">
        <button class="btn sm ago-back" title="Back to groups" onclick="agoBackToGroups()">‹</button>
        <div class="ago-head-text"><span class="ago-chan-name">Agora</span></div>
      </div>
      <div class="empty"><div class="glyph">▣</div>
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
  box.innerHTML = `
    <div class="ago-head">
      <button class="btn sm ago-back" title="Back to groups" onclick="agoBackToGroups()">‹</button>
      <div class="ago-head-text">
        <span class="ago-chan-name"><span class="hash">#</span>${esc(channel.name)}</span>
        <span class="dim">${esc(group.name)}</span>
      </div>
      <div class="ago-head-actions">
        <button class="btn sm ago-star-toggle ${_agoStarsOpen ? "active" : ""}"
          title="Starred messages in #${esc(channel.name)}"
          onclick="agoToggleStarList()">${_agoStars.length ? "★ " + _agoStars.length : "☆"}</button>
        <button class="btn sm ${_agoMembers ? "active" : ""}" onclick="agoToggleMembers()">Members</button>
        ${agoIsAdmin()
          ? `<button class="btn sm danger ${agoArmed("group:" + group.id) ? "armed" : ""}" onclick="agoDeleteGroup()">
               ${agoArmed("group:" + group.id) ? "Sure? This deletes everything" : "Delete group"}</button>`
          : ""}
      </div>
    </div>
    ${agoPinBarHTML()}
    ${agoStarPopHTML()}
    ${noAgents}
    <div class="ago-unread-bar" id="ago-unread-bar" style="display:none"></div>
    <div class="ago-log" id="ago-log" onscroll="agoOnScroll()"></div>
    <div class="ago-status" id="ago-status"></div>
    ${agoFileChipsHTML(null)}
    <div class="chat-input" ondragover="agoDragOver(event)" ondrop="agoDrop(event, null)">
      <textarea id="ago-msg" rows="1" placeholder="Message #${esc(channel.name)}"
        title="@mention an agent to address it directly"
        onkeydown="agoKeydown(event, null)" oninput="autoGrow(this); agoMentionInput('ago-msg')"
        onpaste="agoPaste(event, null)"
        onblur="setTimeout(agoCloseMention, 150)"></textarea>
      ${agoAttachBtnHTML(null)}
      <button class="btn primary" onclick="agoSend(null)">Send</button>
    </div>`;
  const msgBox = document.getElementById("ago-msg");
  if (msgBox && draft) { msgBox.value = draft; autoGrow(msgBox); }
  agoDrawMessages();
  agoDrawStatus();
  agoDrawMembers();
}

/* ---------- pinned threads ---------- */
function agoIsPinned(id) { return _agoPins.some(p => p.id === id); }

function agoPinSnippet(m) {
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
            onclick="event.stopPropagation(); agoTogglePin(${p.id})">✕</button>
        </div>`).join("")}
    </div>` : "";
  return `
    <div class="ago-pin-wrap">
      <button class="ago-pinbar ${_agoPinsOpen ? "open" : ""}" onclick="agoTogglePinList()"
        title="${_agoPinsOpen ? "Hide pinned threads" : "Show pinned threads"}">
        <span class="ago-pin-ico">📌</span>
        <span class="ago-pin-count">${_agoPins.length} pinned</span>
        ${!_agoPinsOpen ? `<span class="ago-pin-preview">${esc(agoPinSnippet(first))}</span>` : ""}
        <span class="ago-pin-caret">${_agoPinsOpen ? "▴" : "▾"}</span>
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
        onclick="event.stopPropagation(); agoToggleStar(${s.id})">✕</button>
    </div>`).join("")
    : `<div class="dim" style="padding:10px 12px;font-size:12px">
         Nothing starred in this channel yet — hover a message and hit ☆ star.</div>`;
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
  if (s.thread_id != null) {
    await agoOpenThread(s.thread_id);
    agoFlashMessage("ago-thread-log", id);
    return;
  }
  if (!_agoMsgs.some(m => m.id === id)) {
    const channel = agoSelChannel();
    try {
      const data = await api(
        `/api/channels/${encodeURIComponent(channel.id)}/messages?before_id=${id + 1}&limit=100`);
      _agoMsgs = data.messages || [];
      agoDrawMessages();
    } catch (e) { return; }
  }
  agoFlashMessage("ago-log", id);
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
    ? `<button class="ago-thread-btn" title="Reply in thread" onclick="agoOpenThread(${m.id})">↳ thread</button>`
    : "";
  const pinnable = m.thread_id == null;
  const pinned = pinnable && agoIsPinned(m.id);
  const pinBtn = pinnable
    ? `<button class="ago-thread-btn ago-pin-btn ${pinned ? "pinned" : ""}"
         title="${pinned ? "Unpin this thread" : "Pin this thread for quick access"}"
         onclick="agoTogglePin(${m.id})">${pinned ? "📌 unpin" : "⚲ pin"}</button>`
    : "";
  const starred = agoIsStarred(m.id);
  const starBtn = `<button class="ago-thread-btn ago-star-btn ${starred ? "starred" : ""}"
       title="${starred ? "Remove from your starred messages" : "Star this message"}"
       onclick="agoToggleStar(${m.id})">${starred ? "★ starred" : "☆ star"}</button>`;
  const foot = `<div class="ago-bubble-foot">${replies}${threadBtn}${pinBtn}${starBtn}</div>`;
  const mark = (pinned ? '<span class="ago-pinned-mark" title="Pinned">📌</span>' : "")
    + (starred ? '<span class="ago-starred-mark" title="Starred by you">★</span>' : "");
  return `<div class="bubble ${cls} ago-bubble" data-mid="${m.id}"><div class="who"><span class="who-name">${esc(agoAuthorLabel(m))}${m.author_type === "agent" ? " · agent" : ""}</span>${mark}<span class="bubble-ts">${esc(fmtTs(m.ts))}</span></div>${agoMd(m.text)}${agoAttachmentsHTML(m)}${foot}</div>`;
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
    || `<div class="empty"><div class="glyph">◍</div><div>No messages yet</div>
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
    `<div class="ago-progress">⚙ <b>${esc(p.agent_name)}</b> ${esc(p.text)}</div>`);
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
      ${c.type === "agent" ? agoAgentAvatarHTML(c.id, "sm") : '<span class="ago-av sm">👤</span>'}
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
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); agoSend(threadId); }
}
async function agoSend(threadId) {
  agoCloseMention();
  const input = document.getElementById(threadId ? "ago-thread-msg" : "ago-msg");
  const channel = agoSelChannel();
  if (!input || !channel) return;
  const text = input.value.trim();
  const files = agoPendingFiles(threadId);
  if (!text && !files.length) return;
  input.value = "";
  autoGrow(input);
  try {
    let msg;
    if (files.length) {
      const fd = new FormData();
      fd.append("text", text);
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
        threadId ? { text, thread_id: threadId } : { text });
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

function agoPickFiles(threadId) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.onchange = () => agoAddFiles(threadId, inp.files);
  inp.click();
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
    onclick="agoPickFiles(${arg})">📎</button>`;
}

function agoFileChipsHTML(threadId) {
  const files = agoPendingFiles(threadId);
  if (!files.length) return "";
  const arg = threadId != null ? threadId : "null";
  return `<div class="ago-pending">${files.map((f, i) => `
    <span class="ago-pending-chip" title="${esc(f.name)}">
      ${(f.type || "").startsWith("image/") ? "🖼" : "📄"}
      <span class="fname">${esc(f.name)}</span>
      <span class="fsize">${agoHumanSize(f.size)}</span>
      <button class="ago-x" title="Remove" onclick="agoRemoveFile(${arg}, ${i})">✕</button>
    </span>`).join("")}</div>`;
}

function agoRedrawComposer(threadId) {
  if (threadId != null) agoDrawThread(); else agoDrawMain();
}

/* Attachment URLs carry the token in the query — <img> tags can't set an
   Authorization header. */
function agoFileUrl(id) {
  const t = sessionToken();
  return `/api/files/${encodeURIComponent(id)}${t ? "?token=" + encodeURIComponent(t) : ""}`;
}

function agoAttachmentsHTML(m) {
  const files = m.attachments || [];
  if (!files.length) return "";
  const parts = files.map(f => {
    const url = agoFileUrl(f.id);
    if ((f.mime || "").startsWith("image/")) {
      return `<a class="ago-att-img" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(f.filename)}" loading="lazy"></a>`;
    }
    return `<a class="ago-att-file" href="${url}" download="${esc(f.filename)}" title="Download ${esc(f.filename)}">📄 <span class="fname">${esc(f.filename)}</span> <span class="fsize">${agoHumanSize(f.size)}</span></a>`;
  });
  return `<div class="ago-atts">${parts.join("")}</div>`;
}

/* ---------- thread panel ---------- */
async function agoOpenThread(rootId) {
  const channel = agoSelChannel();
  if (!channel) return;
  _agoThreadRoot = _agoMsgs.find(m => m.id === rootId)
    || _agoPins.find(p => p.id === rootId)
    || (_agoStars.find(s => s.root && s.root.id === rootId) || {}).root
    || null;
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
}
function agoCloseThread() {
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
        onclick="agoCloseThread()">‹</button>
      <div class="ago-head-text">
        <span class="ago-chan-name">Thread</span>
        ${channel ? `<span class="dim"><span class="hash">#</span>${esc(channel.name)}</span>` : ""}
      </div>
      <div class="ago-head-actions">
        <button class="btn sm ${agoIsPinned(_agoThreadRoot.id) ? "active" : ""}"
          title="${agoIsPinned(_agoThreadRoot.id) ? "Unpin this thread" : "Pin this thread for quick access"}"
          onclick="agoTogglePin(${_agoThreadRoot.id})">${agoIsPinned(_agoThreadRoot.id) ? "📌 Pinned" : "⚲ Pin"}</button>
        <button class="btn sm ago-thread-expand" title="${_agoThreadExpanded ? "Shrink thread back to the side panel" : "Expand thread to full width"}"
          onclick="agoToggleThreadSize()">${_agoThreadExpanded ? "⤡" : "⤢"}</button>
        <button class="btn sm ago-thread-close" onclick="agoCloseThread()">✕</button>
      </div>
    </div>
    <div class="ago-log ago-thread-log" id="ago-thread-log">
      ${agoMsgHTML(_agoThreadRoot, true)}
      <div class="ago-thread-sep">${_agoThreadMsgs.length} repl${_agoThreadMsgs.length === 1 ? "y" : "ies"}</div>
      ${_agoThreadMsgs.map(m => agoMsgHTML(m, true)).join("")}
    </div>
    <div class="ago-status" id="ago-thread-status"></div>
    ${agoFileChipsHTML(_agoThreadRoot.id)}
    <div class="chat-input" ondragover="agoDragOver(event)" ondrop="agoDrop(event, ${_agoThreadRoot.id})">
      <textarea id="ago-thread-msg" rows="1" placeholder="Reply in thread…"
        onkeydown="agoKeydown(event, ${_agoThreadRoot.id})" oninput="autoGrow(this); agoMentionInput('ago-thread-msg')"
        onpaste="agoPaste(event, ${_agoThreadRoot.id})"
        onblur="setTimeout(agoCloseMention, 150)"></textarea>
      ${agoAttachBtnHTML(_agoThreadRoot.id)}
      <button class="btn primary" onclick="agoSend(${_agoThreadRoot.id})">Send</button>
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
      : `<span class="ago-av sm">👤</span>`;
    return `
    <div class="ago-member">
      ${mark}
      <span class="mname">${esc(m.name || m.member_id)}</span>
      <span class="mmeta">${esc(m.role)}${m.channel_id ? " · " + esc(chanName(m.channel_id)) : ""}${off
        ? ' · <span class="ago-off">offline — won\u2019t reply</span>' : ""}</span>
      ${admin ? `<button class="ago-x" title="Remove"
        onclick="agoRemoveMember('${esc(m.member_type)}','${esc(m.member_id)}','${esc(m.channel_id || "")}')">✕</button>` : ""}
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
      <button class="btn sm" title="Close members" onclick="agoToggleMembers()">✕</button>
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
  const channel = agoSelChannel();
  const open = !!(channel && m.channel_id === channel.id);
  const mine = m.author_type === "user" && CURRENT_USER && m.author_id === CURRENT_USER.username;
  if (mine) {
    const u = _agoUnread[m.channel_id];
    if (u) u.last_read_id = Math.max(u.last_read_id, m.id);
  } else {
    const box = open ? document.getElementById("ago-log") : null;
    const seenNow = open && document.visibilityState === "visible"
      && document.hasFocus() && box && agoAtBottom(box);
    if (!seenNow) {
      const u = _agoUnread[m.channel_id] || (_agoUnread[m.channel_id] = { count: 0, last_read_id: 0 });
      u.count += 1;
      agoDrawSide();
      if (open) agoDrawUnreadBar();
    }
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
  }
  if (!mine) agoMaybeMarkRead();
}

function agoHandleEvent(data) {
  const channel = agoSelChannel();
  if (data.type === "message") { agoIngestMessage(data.message); return; }
  if (data.type === "read") { agoApplyRead(data.channel_id, data.last_read_id); return; }
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
