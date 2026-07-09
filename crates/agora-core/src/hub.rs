//! The hub: Agora's in-process message bus.
//!
//! A posted message is persisted, broadcast to every connected UI websocket
//! that may see the channel, and fanned out to each member agent's live
//! connection (dial-in bridge or dial-out Pantheo link) as an `inbound`
//! protocol frame. Agent `post` frames come back through the same hub, so
//! every viewer of a channel sees the whole conversation.
//!
//! Ported from Pantheo's `engine/agora/hub.py`; the wire events pushed to UI
//! sockets are shape-identical so the ported web UI works unchanged.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::store::{slugify, NewAttachment, Store};

/// Max consecutive agent-authored messages fanned out to other agents in one
/// channel/thread before the hub goes quiet until a human speaks again.
pub const BOT_LOOP_LIMIT: i64 = 4;

/// How much of a thread's root message is inlined as context when an agent
/// first joins the thread.
const ROOT_CONTEXT_MAX_CHARS: usize = 500;

/// Attachments larger than this are referenced by name only in the inbound
/// frame (no inline bytes) — remote agents may not be able to reach our HTTP.
pub const MAX_INLINE_ATTACHMENT: usize = 8 * 1024 * 1024;

/// Minimum gap between notifications for the same channel, so a burst of
/// agent replies (or a bot exchange) becomes one banner, not a pile.
const NOTIFY_THROTTLE: Duration = Duration::from_secs(5);

/// Longest notification body; longer messages are cut at a char boundary.
const NOTIFY_BODY_MAX_CHARS: usize = 180;

/// A new-message notification for the platform layer (the desktop shell
/// shows it natively; headless deployments simply don't set a notifier).
#[derive(Clone, Debug)]
pub struct NotifyEvent {
    pub channel_id: String,
    /// "Author — Group / #channel"
    pub title: String,
    /// Message snippet.
    pub body: String,
}

type Notifier = Box<dyn Fn(NotifyEvent) + Send + Sync>;

pub fn mention_tokens(text: &str) -> Vec<String> {
    // @name tokens: alnum start, then word chars / dots / dashes.
    let mut out = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '@' && i + 1 < bytes.len() && bytes[i + 1].is_alphanumeric() {
            let mut j = i + 1;
            while j < bytes.len()
                && (bytes[j].is_alphanumeric() || bytes[j] == '_' || bytes[j] == '.' || bytes[j] == '-')
            {
                j += 1;
            }
            out.push(bytes[i + 1..j].iter().collect::<String>().to_lowercase());
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// A live agent registration: which connection it arrived on and how to
/// push frames to that connection.
#[derive(Clone)]
pub struct AgentHandle {
    pub agent_id: String,
    pub agent_name: String,
    pub requires_mention: bool,
    /// Label of the connection ("pantheo-home", "pairing:xyz", ...).
    pub source: String,
    /// Internal id of the carrying connection (one connection may carry
    /// several agents; dropping it unregisters them all).
    pub conn_id: u64,
    pub tx: UnboundedSender<Value>,
}

struct UiSocket {
    id: u64,
    username: String,
    privileged: bool,
    tx: UnboundedSender<Value>,
}

#[derive(Default)]
struct HubState {
    agents: HashMap<String, AgentHandle>,
    sockets: Vec<UiSocket>,
    next_id: u64,
    /// Consecutive agent-authored messages per (channel_id, thread_id or 0).
    bot_streak: HashMap<(String, i64), i64>,
    /// channel_id -> {"typing": {agent_id: event}, "progress": {handle: event}}
    activity: HashMap<String, Activity>,
    /// channel_id -> when it was last notified (see NOTIFY_THROTTLE).
    last_notified: HashMap<String, Instant>,
}

#[derive(Default, Clone)]
struct Activity {
    typing: HashMap<String, Value>,
    progress: HashMap<String, Value>,
}

pub struct Hub {
    pub store: Arc<Store>,
    state: Mutex<HubState>,
    /// Whether the user is actively looking at the app (desktop window
    /// focused). Set by the shell; defaults to true so a headless server —
    /// which never has a notifier anyway — behaves neutrally.
    ui_active: AtomicBool,
    /// Platform notification callback (desktop shell only).
    notifier: Mutex<Option<Notifier>>,
}

impl Hub {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            state: Mutex::new(HubState::default()),
            ui_active: AtomicBool::new(true),
            notifier: Mutex::new(None),
        }
    }

    // ------------------------------------------------------------- notifications

    pub fn set_notifier(&self, f: impl Fn(NotifyEvent) + Send + Sync + 'static) {
        *self.notifier.lock().unwrap() = Some(Box::new(f));
    }

    /// The shell reports window focus; while inactive, new messages the user
    /// hasn't seen surface as platform notifications.
    pub fn set_ui_active(&self, active: bool) {
        self.ui_active.store(active, Ordering::Relaxed);
    }

    /// Notify about a freshly posted message when nobody is looking.
    ///
    /// Mirrors the seen/unseen model: a message is "seen" only when the app
    /// is focused (the UI acks reads under the same visibility rule), so an
    /// unfocused window means this message is landing unread. Throttled per
    /// channel so bursts collapse into one banner.
    fn maybe_notify(&self, message: &Value) {
        if self.ui_active.load(Ordering::Relaxed) {
            return;
        }
        let notifier = self.notifier.lock().unwrap();
        let Some(notify) = notifier.as_ref() else { return };
        let channel_id = message["channel_id"].as_str().unwrap_or_default();
        {
            let mut st = self.state.lock().unwrap();
            if let Some(at) = st.last_notified.get(channel_id) {
                if at.elapsed() < NOTIFY_THROTTLE {
                    return;
                }
            }
            st.last_notified.insert(channel_id.to_string(), Instant::now());
        }
        let place = match self.store.channel(channel_id) {
            Some(channel) => {
                let chan_name = channel["name"].as_str().unwrap_or("?").to_string();
                match self.store.group(channel["group_id"].as_str().unwrap_or_default()) {
                    Some(g) => format!("{} / #{}", g["name"].as_str().unwrap_or("?"), chan_name),
                    None => format!("#{chan_name}"),
                }
            }
            None => return,
        };
        let author = message["author_name"]
            .as_str()
            .or(message["author_id"].as_str())
            .unwrap_or("?");
        let mut body: String = message["text"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(NOTIFY_BODY_MAX_CHARS)
            .collect();
        if body.is_empty() {
            body = "New message".to_string();
        } else if message["text"].as_str().unwrap_or_default().chars().count()
            > NOTIFY_BODY_MAX_CHARS
        {
            body.push('…');
        }
        notify(NotifyEvent {
            channel_id: channel_id.to_string(),
            title: format!("{author} — {place}"),
            body,
        });
    }

    // ------------------------------------------------------------- agents

    pub fn next_conn_id(&self) -> u64 {
        let mut st = self.state.lock().unwrap();
        st.next_id += 1;
        st.next_id
    }

    pub fn register_agent(&self, handle: AgentHandle) {
        self.store.upsert_agent(
            &handle.agent_id,
            &handle.agent_name,
            &handle.source,
            handle.requires_mention,
        );
        let mut st = self.state.lock().unwrap();
        st.agents.insert(handle.agent_id.clone(), handle);
    }

    /// Drop every agent that arrived on `conn_id`; clears their stale
    /// typing/progress lines so late viewers don't see ghosts.
    pub fn unregister_connection(&self, conn_id: u64) -> Vec<String> {
        let mut st = self.state.lock().unwrap();
        let gone: Vec<String> = st
            .agents
            .values()
            .filter(|h| h.conn_id == conn_id)
            .map(|h| h.agent_id.clone())
            .collect();
        for id in &gone {
            st.agents.remove(id);
        }
        let channels: Vec<String> = st.activity.keys().cloned().collect();
        for cid in channels {
            for aid in &gone {
                drop_agent_activity(&mut st, &cid, aid);
            }
        }
        gone
    }

    pub fn live_agent_ids(&self) -> Vec<String> {
        self.state.lock().unwrap().agents.keys().cloned().collect()
    }

    pub fn agent_handle(&self, agent_id: &str) -> Option<AgentHandle> {
        self.state.lock().unwrap().agents.get(agent_id).cloned()
    }

    /// The channel's member agents that are live right now (id + name).
    pub fn channel_agents(&self, channel_id: &str) -> Vec<Value> {
        let members = self.store.agents_for_channel(channel_id);
        let st = self.state.lock().unwrap();
        members
            .iter()
            .filter_map(|id| st.agents.get(id))
            .map(|h| json!({"id": h.agent_id, "name": h.agent_name}))
            .collect()
    }

    // ------------------------------------------------------------- sockets

    pub fn attach_socket(&self, username: &str, privileged: bool, tx: UnboundedSender<Value>) -> u64 {
        let mut st = self.state.lock().unwrap();
        st.next_id += 1;
        let id = st.next_id;
        st.sockets.push(UiSocket {
            id,
            username: username.to_string(),
            privileged,
            tx,
        });
        id
    }

    pub fn detach_socket(&self, socket_id: u64) {
        let mut st = self.state.lock().unwrap();
        st.sockets.retain(|s| s.id != socket_id);
    }

    /// Push an event to every UI socket allowed to see the channel. Failed
    /// sends mark dead sockets, which are dropped; never raises.
    fn broadcast(&self, channel_id: &str, event: &Value) {
        // Membership checks hit the store; collect targets under the lock,
        // check visibility outside it to keep the lock scope small.
        let targets: Vec<(u64, String, bool, UnboundedSender<Value>)> = {
            let st = self.state.lock().unwrap();
            st.sockets
                .iter()
                .map(|s| (s.id, s.username.clone(), s.privileged, s.tx.clone()))
                .collect()
        };
        let mut dead = Vec::new();
        for (id, username, privileged, tx) in targets {
            if !privileged && !self.store.user_can_see_channel(&username, channel_id) {
                continue;
            }
            if tx.send(event.clone()).is_err() {
                dead.push(id);
            }
        }
        for id in dead {
            self.detach_socket(id);
        }
    }

    /// Push an event to every socket belonging to one user only — personal
    /// state (read markers) other viewers must not see.
    fn send_to_user(&self, username: &str, event: &Value) {
        let targets: Vec<(u64, UnboundedSender<Value>)> = {
            let st = self.state.lock().unwrap();
            st.sockets
                .iter()
                .filter(|s| s.username == username)
                .map(|s| (s.id, s.tx.clone()))
                .collect()
        };
        for (id, tx) in targets {
            if tx.send(event.clone()).is_err() {
                self.detach_socket(id);
            }
        }
    }

    // ------------------------------------------------------------- reads

    pub fn mark_read(&self, username: &str, channel_id: &str, message_id: Option<i64>) -> i64 {
        let last = self.store.mark_read(username, channel_id, message_id);
        self.send_to_user(
            username,
            &json!({"type": "read", "channel_id": channel_id, "last_read_id": last}),
        );
        last
    }

    /// Advance a per-thread read marker and tell the user's other devices.
    pub fn mark_thread_read(
        &self,
        username: &str,
        thread_id: i64,
        message_id: Option<i64>,
    ) -> i64 {
        let last = self.store.mark_thread_read(username, thread_id, message_id);
        let channel_id = self
            .store
            .message(thread_id)
            .and_then(|m| m["channel_id"].as_str().map(str::to_string))
            .unwrap_or_default();
        self.send_to_user(
            username,
            &json!({
                "type": "thread_read", "thread_id": thread_id,
                "channel_id": channel_id, "last_read_id": last,
            }),
        );
        last
    }

    /// Persist @user mentions so unread badges can distinguish "spoken to
    /// you" from mere traffic. Matches mention tokens against the channel's
    /// group members; self-mentions are ignored.
    fn record_mentions(&self, message: &Value) {
        let tokens = mention_tokens(message["text"].as_str().unwrap_or_default());
        if tokens.is_empty() {
            return;
        }
        let channel_id = message["channel_id"].as_str().unwrap_or_default();
        let Some(channel) = self.store.channel(channel_id) else { return };
        let group_id = channel["group_id"].as_str().unwrap_or_default();
        let author_is_user = message["author_type"] == "user";
        let author_id = message["author_id"].as_str().unwrap_or_default();
        let mentioned: Vec<String> = self
            .store
            .members(group_id)
            .iter()
            .filter(|m| m["member_type"] == "user")
            .filter_map(|m| m["member_id"].as_str().map(str::to_string))
            .filter(|u| tokens.contains(&u.to_lowercase()))
            .filter(|u| !(author_is_user && u == author_id))
            .collect();
        if let Some(id) = message["id"].as_i64() {
            self.store.add_mentions(id, channel_id, &mentioned);
        }
    }

    // ------------------------------------------------------------- posting

    pub fn post_user_message(
        &self,
        channel_id: &str,
        text: &str,
        username: &str,
        user_name: Option<&str>,
        thread_id: Option<i64>,
        attachments: Vec<NewAttachment>,
    ) -> Value {
        let message = self.store.add_message(
            channel_id,
            text,
            "user",
            username,
            Some(user_name.unwrap_or(username)),
            thread_id,
            &attachments,
        );
        {
            let mut st = self.state.lock().unwrap();
            st.bot_streak.remove(&(channel_id.to_string(), thread_id.unwrap_or(0)));
        }
        // Your own message is never unread to you.
        self.store
            .mark_read(username, channel_id, message["id"].as_i64());
        if let Some(tid) = thread_id {
            self.store
                .mark_thread_read(username, tid, message["id"].as_i64());
        }
        self.record_mentions(&message);
        self.broadcast(channel_id, &json!({"type": "message", "message": message}));
        self.fan_out(&message, false, None, false);
        message
    }

    /// An agent's outbound message. Broadcast to viewers; relayed to *other*
    /// member agents only when @mentioned, under the bot-loop cap.
    pub fn post_agent_message(
        &self,
        agent_id: &str,
        agent_name: &str,
        channel_id: &str,
        text: &str,
        thread_id: Option<i64>,
    ) -> Value {
        let message = self.store.add_message(
            channel_id,
            text,
            "agent",
            agent_id,
            Some(agent_name),
            thread_id,
            &[],
        );
        let streak = {
            let mut st = self.state.lock().unwrap();
            let key = (channel_id.to_string(), thread_id.unwrap_or(0));
            let v = st.bot_streak.entry(key).or_insert(0);
            *v += 1;
            *v
        };
        self.record_mentions(&message);
        self.broadcast(channel_id, &json!({"type": "message", "message": message}));
        // Agent replies are the only messages not authored by the (single)
        // local user, so they're the ones worth a notification.
        self.maybe_notify(&message);
        if streak <= BOT_LOOP_LIMIT {
            self.fan_out(&message, true, Some(agent_id), true);
        } else if streak == BOT_LOOP_LIMIT + 1 {
            tracing::info!("bot-loop limit hit in {channel_id} (thread {thread_id:?})");
        }
        message
    }

    /// Broadcast a non-persisted event (typing, progress, pin) to viewers.
    pub fn post_transient(&self, channel_id: &str, event: Value) {
        self.record_activity(channel_id, &event);
        self.broadcast(channel_id, &event);
    }

    fn record_activity(&self, channel_id: &str, event: &Value) {
        let mut st = self.state.lock().unwrap();
        match event["type"].as_str() {
            Some("typing") => {
                let agent_id = event["agent_id"].as_str().unwrap_or_default().to_string();
                if event["active"].as_bool().unwrap_or(false) {
                    st.activity
                        .entry(channel_id.to_string())
                        .or_default()
                        .typing
                        .insert(agent_id, event.clone());
                } else {
                    // Agent finished: its progress lines are stale too.
                    drop_agent_activity(&mut st, channel_id, &agent_id);
                }
            }
            Some("progress") => {
                let handle = event["handle"].as_str().unwrap_or_default().to_string();
                st.activity
                    .entry(channel_id.to_string())
                    .or_default()
                    .progress
                    .insert(handle, event.clone());
            }
            _ => {}
        }
    }

    /// Current in-flight typing/progress — what a viewer opening the channel
    /// right now should render.
    pub fn channel_activity(&self, channel_id: &str) -> Value {
        let st = self.state.lock().unwrap();
        let chan = st.activity.get(channel_id);
        json!({
            "typing": chan.map(|c| c.typing.values().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            "progress": chan.map(|c| c.progress.values().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        })
    }

    // ------------------------------------------------------------- fan-out

    fn fan_out(
        &self,
        message: &Value,
        from_bot: bool,
        exclude_agent: Option<&str>,
        mentioned_only: bool,
    ) {
        let channel_id = message["channel_id"].as_str().unwrap_or_default();
        let Some(channel) = self.store.channel(channel_id) else {
            return;
        };
        let tokens = mention_tokens(message["text"].as_str().unwrap_or_default());
        for agent_id in self.store.agents_for_channel(channel_id) {
            if Some(agent_id.as_str()) == exclude_agent {
                continue;
            }
            let Some(handle) = self.agent_handle(&agent_id) else {
                continue;
            };
            let mentioned = tokens.contains(&agent_id.to_lowercase())
                || tokens.contains(&slugify(&handle.agent_name));
            if mentioned_only && !mentioned {
                continue;
            }
            if handle.requires_mention && !mentioned {
                continue;
            }
            let inbound = self.build_inbound(message, &channel, &handle, mentioned, from_bot);
            let _ = handle.tx.send(inbound);
        }
    }

    fn build_inbound(
        &self,
        message: &Value,
        channel: &Value,
        handle: &AgentHandle,
        mentioned: bool,
        from_bot: bool,
    ) -> Value {
        let mut text = message["text"].as_str().unwrap_or_default().to_string();
        let thread_id = message["thread_id"].as_i64();
        // First reply in a thread: inline the root message so the agent's
        // fresh per-thread session starts with what the thread is about.
        if let Some(tid) = thread_id {
            if self.store.thread_size(tid) == 1 {
                if let Some(root) = self.store.message(tid) {
                    let root_text = root["text"].as_str().unwrap_or_default();
                    let snippet: String = root_text.chars().take(ROOT_CONTEXT_MAX_CHARS).collect();
                    let author = root["author_name"]
                        .as_str()
                        .or(root["author_id"].as_str())
                        .unwrap_or("?");
                    text = format!("[thread on: \"{snippet}\" — by {author}]\n{text}");
                }
            }
        }
        let group = self.store.group(channel["group_id"].as_str().unwrap_or_default());
        let chat_name = match &group {
            Some(g) => format!(
                "{} / {}",
                g["name"].as_str().unwrap_or("?"),
                channel["name"].as_str().unwrap_or("?")
            ),
            None => channel["name"].as_str().unwrap_or("?").to_string(),
        };
        // Inline attachment bytes (base64) so remote agents don't need HTTP
        // reachability back to us; oversized files ride as name-only refs.
        let mut atts = Vec::new();
        for f in message["attachments"].as_array().cloned().unwrap_or_default() {
            let file_id = f["id"].as_str().unwrap_or_default();
            let size = f["size"].as_i64().unwrap_or(0) as usize;
            let mut entry = json!({
                "filename": f["filename"], "mime": f["mime"], "size": f["size"],
            });
            if size <= MAX_INLINE_ATTACHMENT {
                if let Ok(data) = std::fs::read(self.store.file_path(file_id)) {
                    entry["data_b64"] =
                        json!(base64::engine::general_purpose::STANDARD.encode(data));
                }
            }
            atts.push(entry);
        }
        json!({
            "type": "inbound",
            "agent_id": handle.agent_id,
            "message_id": message["id"],
            "channel_id": message["channel_id"],
            "thread_id": thread_id,
            "author": {
                "type": message["author_type"],
                "id": message["author_id"],
                "name": message["author_name"],
            },
            "text": text,
            "chat_name": chat_name,
            "context_note": self.context_note(channel, &group, thread_id, handle),
            "mentioned": mentioned,
            "from_bot": from_bot,
            "attachments": atts,
        })
    }

    /// "Where you are" prompt block for the agent: group, channel, thread
    /// root, member agents with @mention handles, and people with roles.
    fn context_note(
        &self,
        channel: &Value,
        group: &Option<Value>,
        thread_id: Option<i64>,
        handle: &AgentHandle,
    ) -> String {
        let mut lines = vec![
            "You are chatting in Agora, a group chat platform for agents and people \
             (groups contain channels; messages can branch into threads)."
                .to_string(),
        ];
        if let Some(g) = group {
            let desc = g["description"].as_str().unwrap_or_default();
            lines.push(format!(
                "Group: {}{}",
                g["name"].as_str().unwrap_or("?"),
                if desc.is_empty() { String::new() } else { format!(" — {desc}") }
            ));
        }
        let topic = channel["topic"].as_str().unwrap_or_default();
        lines.push(format!(
            "Channel: #{}{}",
            channel["name"].as_str().unwrap_or("?"),
            if topic.is_empty() { String::new() } else { format!(" — {topic}") }
        ));
        if let Some(tid) = thread_id {
            if let Some(root) = self.store.message(tid) {
                let root_text = root["text"].as_str().unwrap_or_default();
                let snippet: String = root_text.chars().take(140).collect();
                let ellipsis = if root_text.chars().count() > 140 { "…" } else { "" };
                let author = root["author_name"]
                    .as_str()
                    .or(root["author_id"].as_str())
                    .unwrap_or("?");
                lines.push(format!(
                    "Thread: you are replying in a thread under {author}'s message: \"{snippet}{ellipsis}\""
                ));
            }
        }
        let channel_id = channel["id"].as_str().unwrap_or_default();
        let group_id = channel["group_id"].as_str().unwrap_or_default();
        let (mut agents, mut people) = (Vec::new(), Vec::new());
        {
            let st = self.state.lock().unwrap();
            for m in self.store.members(group_id) {
                // Skip members scoped to a *different* channel of this group.
                if let Some(scoped) = m["channel_id"].as_str() {
                    if !scoped.is_empty() && scoped != channel_id {
                        continue;
                    }
                }
                let member_id = m["member_id"].as_str().unwrap_or_default();
                if m["member_type"] == "agent" {
                    let live = st.agents.get(member_id);
                    let name = live
                        .map(|h| h.agent_name.clone())
                        .or_else(|| {
                            self.store.agent(member_id).and_then(|a| {
                                a["name"].as_str().map(String::from)
                            })
                        })
                        .unwrap_or_else(|| member_id.to_string());
                    if member_id == handle.agent_id {
                        agents.push(format!("{name} (you)"));
                    } else if live.is_some() {
                        agents.push(format!("{name} (@{})", slugify(&name)));
                    } else {
                        agents.push(format!("{name} (offline)"));
                    }
                } else {
                    people.push(format!("{member_id} ({})", m["role"].as_str().unwrap_or("member")));
                }
            }
        }
        if !agents.is_empty() {
            lines.push(format!("Agents in this channel: {}.", agents.join(", ")));
        }
        if !people.is_empty() {
            lines.push(format!("People in this group: {}.", people.join(", ")));
        }
        lines.push(format!(
            "Anyone here can address a specific agent with its @mention; your replies post to this channel{}",
            if thread_id.is_some() { " thread." } else { "." }
        ));
        lines.push(
            "Formatting: this chat renders Markdown including GitHub-style pipe \
             tables. Prefer a table when presenting tabular or comparative data."
                .to_string(),
        );
        lines.join("\n")
    }

    // ------------------------------------------------------------- agent frames

    /// Handle a protocol frame arriving from an agent connection.
    pub fn handle_agent_frame(&self, frame: &Value) {
        let agent_id = frame["agent_id"].as_str().unwrap_or_default().to_string();
        let agent_name = self
            .agent_handle(&agent_id)
            .map(|h| h.agent_name)
            .unwrap_or_else(|| agent_id.clone());
        let channel_id = frame["channel_id"].as_str().unwrap_or_default().to_string();
        if channel_id.is_empty() || self.store.channel(&channel_id).is_none() {
            return;
        }
        let thread_id = frame["thread_id"].as_i64();
        match frame["type"].as_str() {
            Some("post") => {
                let text = frame["text"].as_str().unwrap_or_default();
                if !text.is_empty() {
                    self.post_agent_message(&agent_id, &agent_name, &channel_id, text, thread_id);
                }
            }
            Some("typing") => {
                self.post_transient(
                    &channel_id,
                    json!({
                        "type": "typing", "channel_id": channel_id, "thread_id": thread_id,
                        "agent_id": agent_id, "agent_name": agent_name,
                        "active": frame["active"].as_bool().unwrap_or(false),
                    }),
                );
            }
            Some("progress") => {
                self.post_transient(
                    &channel_id,
                    json!({
                        "type": "progress", "channel_id": channel_id, "thread_id": thread_id,
                        "agent_id": agent_id, "agent_name": agent_name,
                        "handle": frame["handle"], "text": frame["text"],
                    }),
                );
            }
            _ => {}
        }
    }
}

fn drop_agent_activity(st: &mut HubState, channel_id: &str, agent_id: &str) {
    if let Some(chan) = st.activity.get_mut(channel_id) {
        chan.typing.remove(agent_id);
        chan.progress.retain(|_, e| e["agent_id"].as_str() != Some(agent_id));
        if chan.typing.is_empty() && chan.progress.is_empty() {
            st.activity.remove(channel_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    fn hub() -> Hub {
        Hub::new(Arc::new(Store::open_in_memory().unwrap()))
    }

    fn add_agent(
        h: &Hub,
        id: &str,
        name: &str,
        requires_mention: bool,
    ) -> tokio::sync::mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = unbounded_channel();
        let conn_id = h.next_conn_id();
        h.register_agent(AgentHandle {
            agent_id: id.into(),
            agent_name: name.into(),
            requires_mention,
            source: "test".into(),
            conn_id,
            tx,
        });
        rx
    }

    fn setup_channel(h: &Hub, agents: &[&str]) -> String {
        let g = h.store.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = h.store.create_channel(gid, "main", "");
        for a in agents {
            h.store.add_member(gid, "agent", a, "member", None);
        }
        c["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn notifications_only_when_ui_inactive_and_throttled() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let seen: Arc<Mutex<Vec<NotifyEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.set_notifier(move |ev| sink.lock().unwrap().push(ev));

        // Focused window: the in-app badge is enough, no banner.
        h.set_ui_active(true);
        h.post_agent_message("bot-a", "Bot A", &cid, "hi", None);
        assert!(seen.lock().unwrap().is_empty());

        h.set_ui_active(false);
        h.post_agent_message("bot-a", "Bot A", &cid, "are you there?", None);
        {
            let events = seen.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].title, "Bot A — G / #main");
            assert_eq!(events[0].body, "are you there?");
            assert_eq!(events[0].channel_id, cid);
        }

        // A burst right after stays one banner (per-channel throttle).
        h.post_agent_message("bot-a", "Bot A", &cid, "hello?", None);
        assert_eq!(seen.lock().unwrap().len(), 1);

        // A user's own post never notifies.
        h.post_user_message(&cid, "back!", "tom", None, None, vec![]);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn notification_body_is_truncated() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let seen: Arc<Mutex<Vec<NotifyEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.set_notifier(move |ev| sink.lock().unwrap().push(ev));
        h.set_ui_active(false);
        h.post_agent_message("bot-a", "Bot A", &cid, &"x".repeat(500), None);
        let events = seen.lock().unwrap();
        assert_eq!(events[0].body.chars().count(), NOTIFY_BODY_MAX_CHARS + 1);
        assert!(events[0].body.ends_with('…'));
    }

    #[test]
    fn fan_out_reaches_member_agents_only() {
        let h = hub();
        let mut rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let mut rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a"]);
        h.post_user_message(&cid, "hello", "tom", Some("Tom"), None, vec![]);
        let frame = rx_a.try_recv().unwrap();
        assert_eq!(frame["type"], "inbound");
        assert_eq!(frame["agent_id"], "bot-a");
        assert_eq!(frame["text"], "hello");
        assert!(frame["context_note"].as_str().unwrap().contains("#main"));
        assert!(rx_b.try_recv().is_err());
    }

    #[test]
    fn requires_mention_gates() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", true);
        let cid = setup_channel(&h, &["bot-a"]);
        h.post_user_message(&cid, "hello", "tom", None, None, vec![]);
        assert!(rx.try_recv().is_err());
        h.post_user_message(&cid, "hey @bot-a", "tom", None, None, vec![]);
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame["mentioned"], true);
    }

    #[test]
    fn mention_matches_slugified_name() {
        let h = hub();
        let mut rx = add_agent(&h, "agent-1", "Data Cruncher", true);
        let cid = setup_channel(&h, &["agent-1"]);
        h.post_user_message(&cid, "@data-cruncher go", "tom", None, None, vec![]);
        assert_eq!(rx.try_recv().unwrap()["mentioned"], true);
    }

    #[test]
    fn agent_relay_mention_only_and_loop_cap() {
        let h = hub();
        let _rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let mut rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a", "bot-b"]);
        // Agent message without mention: no relay.
        h.post_agent_message("bot-a", "Bot A", &cid, "just musing", None);
        assert!(rx_b.try_recv().is_err());
        // With mention: relayed while under the cap.
        for _ in 0..BOT_LOOP_LIMIT {
            h.post_agent_message("bot-a", "Bot A", &cid, "hey @bot-b", None);
        }
        // 1 message already posted + BOT_LOOP_LIMIT more = cap exceeded on last.
        let mut got = 0;
        while rx_b.try_recv().is_ok() {
            got += 1;
        }
        assert_eq!(got, (BOT_LOOP_LIMIT - 1) as usize);
        // Human speaking resets the streak.
        h.post_user_message(&cid, "humans back", "tom", None, None, vec![]);
        assert!(rx_b.try_recv().is_ok());
        h.post_agent_message("bot-a", "Bot A", &cid, "hi again @bot-b", None);
        assert!(rx_b.try_recv().is_ok());
    }

    #[test]
    fn thread_root_seeds_context() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let root = h.post_user_message(&cid, "the plan doc", "tom", None, None, vec![]);
        rx.try_recv().unwrap();
        let root_id = root["id"].as_i64();
        h.post_user_message(&cid, "thoughts?", "tom", None, root_id, vec![]);
        let frame = rx.try_recv().unwrap();
        assert!(frame["text"].as_str().unwrap().starts_with("[thread on: \"the plan doc\""));
        // Second reply: no re-seeding.
        h.post_user_message(&cid, "more", "tom", None, root_id, vec![]);
        assert_eq!(rx.try_recv().unwrap()["text"], "more");
    }

    #[test]
    fn unregister_connection_drops_agents_and_activity() {
        let h = hub();
        let (tx, _rx) = unbounded_channel();
        let conn_id = h.next_conn_id();
        h.register_agent(AgentHandle {
            agent_id: "bot-a".into(),
            agent_name: "Bot A".into(),
            requires_mention: false,
            source: "test".into(),
            conn_id,
            tx,
        });
        let cid = setup_channel(&h, &["bot-a"]);
        h.post_transient(
            &cid,
            json!({"type": "typing", "channel_id": cid, "agent_id": "bot-a", "agent_name": "Bot A", "active": true}),
        );
        assert_eq!(h.channel_activity(&cid)["typing"].as_array().unwrap().len(), 1);
        let gone = h.unregister_connection(conn_id);
        assert_eq!(gone, vec!["bot-a".to_string()]);
        assert!(h.live_agent_ids().is_empty());
        assert!(h.channel_activity(&cid)["typing"].as_array().unwrap().is_empty());
        // Still remembered for the member picker.
        assert!(h.store.agent("bot-a").is_some());
    }

    #[test]
    fn ui_broadcast_respects_membership() {
        let h = hub();
        let cid = setup_channel(&h, &[]);
        let (tx_member, mut rx_member) = unbounded_channel();
        let (tx_out, mut rx_out) = unbounded_channel();
        let (tx_root, mut rx_root) = unbounded_channel();
        h.attach_socket("tom", false, tx_member);
        h.attach_socket("mallory", false, tx_out);
        h.attach_socket("root", true, tx_root);
        h.post_user_message(&cid, "hi", "tom", None, None, vec![]);
        assert_eq!(rx_member.try_recv().unwrap()["type"], "message");
        assert!(rx_out.try_recv().is_err());
        assert_eq!(rx_root.try_recv().unwrap()["type"], "message");
    }

    #[test]
    fn mentions_recorded_for_group_users() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        // Self-mention: not recorded (and your own post acks the channel).
        h.post_user_message(&cid, "note to @tom self", "tom", None, None, vec![]);
        let u = h.store.unread_counts("tom", &[cid.clone()]);
        assert_eq!(u[&cid]["mentions"], 0);
        // Agent @mentions tom: recorded. Unknown token: not recorded.
        h.post_agent_message("bot-a", "Bot A", &cid, "ping @tom", None);
        h.post_agent_message("bot-a", "Bot A", &cid, "cc @nobody", None);
        let u = h.store.unread_counts("tom", &[cid.clone()]);
        assert_eq!(u[&cid]["mentions"], 1);
    }

    #[test]
    fn thread_read_events_go_to_acking_user_only() {
        let h = hub();
        let cid = setup_channel(&h, &[]);
        h.store.add_member(
            h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap(),
            "user",
            "alice",
            "member",
            None,
        );
        let root = h.post_user_message(&cid, "root", "tom", None, None, vec![]);
        let root_id = root["id"].as_i64().unwrap();
        h.post_user_message(&cid, "reply", "tom", None, Some(root_id), vec![]);
        let (tx_tom, mut rx_tom) = unbounded_channel();
        let (tx_alice, mut rx_alice) = unbounded_channel();
        h.attach_socket("tom", false, tx_tom);
        h.attach_socket("alice", false, tx_alice);
        h.mark_thread_read("alice", root_id, None);
        let ev = rx_alice.try_recv().unwrap();
        assert_eq!(ev["type"], "thread_read");
        assert_eq!(ev["thread_id"], root_id);
        assert_eq!(ev["channel_id"], cid);
        assert!(rx_tom.try_recv().is_err());
    }

    #[test]
    fn own_thread_reply_acks_thread_marker() {
        let h = hub();
        let cid = setup_channel(&h, &[]);
        let root = h.post_user_message(&cid, "root", "tom", None, None, vec![]);
        let root_id = root["id"].as_i64().unwrap();
        h.post_user_message(&cid, "my reply", "tom", None, Some(root_id), vec![]);
        let threads = h.store.my_threads("tom", 10);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0]["unread"], 0);
    }

    #[test]
    fn read_events_go_to_acking_user_only() {
        let h = hub();
        let cid = setup_channel(&h, &[]);
        h.store.add_member(
            h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap(),
            "user",
            "alice",
            "member",
            None,
        );
        let (tx_tom, mut rx_tom) = unbounded_channel();
        let (tx_alice, mut rx_alice) = unbounded_channel();
        h.attach_socket("tom", false, tx_tom);
        h.attach_socket("alice", false, tx_alice);
        h.post_user_message(&cid, "hi", "tom", None, None, vec![]);
        rx_tom.try_recv().unwrap();
        rx_alice.try_recv().unwrap();
        h.mark_read("alice", &cid, None);
        assert_eq!(rx_alice.try_recv().unwrap()["type"], "read");
        assert!(rx_tom.try_recv().is_err());
    }

    #[test]
    fn agent_frames_post_and_progress() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let (tx_ui, mut rx_ui) = unbounded_channel();
        h.attach_socket("tom", false, tx_ui);
        h.handle_agent_frame(&json!({
            "type": "progress", "agent_id": "bot-a", "channel_id": cid,
            "handle": "h1", "text": "working...",
        }));
        assert_eq!(rx_ui.try_recv().unwrap()["type"], "progress");
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid, "text": "done!",
        }));
        let ev = rx_ui.try_recv().unwrap();
        assert_eq!(ev["type"], "message");
        assert_eq!(ev["message"]["author_id"], "bot-a");
        assert_eq!(h.store.messages(&cid, None, None, 10).len(), 1);
    }
}
