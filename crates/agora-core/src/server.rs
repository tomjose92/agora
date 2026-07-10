//! The app's HTTP + WebSocket surface (axum).
//!
//! - `/api/*` — the UI's REST API (owner-token auth; single-user v1).
//! - `/ws?token=` — the UI's live event socket.
//! - `/agent/ws?token=` — dial-in agent bridges (pairing-token auth).
//! - `/` — the bundled web UI (static files).
//!
//! Route shapes mirror Pantheo's old `/agora/api/*` so the ported UI's calls
//! stay mechanical: same payloads, same event frames.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc::unbounded_channel;

use crate::config::{Config, Connection, PairingToken};
use crate::connections::ConnectionManager;
use crate::hub::{AgentHandle, Hub};
use crate::store::{new_token, now, NewAttachment};

const MAX_MESSAGE_CHARS: usize = 20_000;
const MAX_PINS_PER_CHANNEL: i64 = 25;
const MAX_FILES_PER_MESSAGE: usize = 5;

/// Upper bound on an uploaded import archive. An import carries the whole
/// database plus every attachment, so it is legitimately large — but a 1 GiB
/// (or unbounded) body is a cheap way to exhaust memory/disk. 256 MiB covers a
/// substantial personal instance; raise it deliberately for a bigger migration.
const MAX_IMPORT_BYTES: usize = 256 * 1024 * 1024;

/// Voice notes: generous for a spoken message (~10 min of Opus), but a hard
/// stop against arbitrary blobs going to the transcription API.
const MAX_VOICE_BYTES: usize = 15 * 1024 * 1024;

/// Synthesized speech per message, LRU-evicted, so replays and multiple
/// listeners don't re-bill the TTS API. ~64 clips of a few hundred KB each.
const SPEECH_CACHE_MAX: usize = 64;

/// message_id -> mp3 bytes, most-recently-used last.
type SpeechCache = std::sync::Mutex<Vec<(i64, Vec<u8>)>>;

/// Requests per client per window on the auth surface (Google sign-in): enough
/// for a real round-trip and retries, low enough to blunt automated abuse of an
/// unauthenticated, externally-expensive path.
const AUTH_RATE_MAX: u32 = 30;
/// Requests per client per window on the upload surface (message/voice/import).
const UPLOAD_RATE_MAX: u32 = 60;
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// Tiny fixed-window rate limiter — no external dependency. Keyed by an opaque
/// string (client IP when known, a shared bucket otherwise). This is an origin
/// backstop, not an edge control: behind a reverse proxy every request shares
/// the proxy's IP, so pair it with a limiter at the edge for real per-client
/// fairness.
pub struct RateLimiter {
    window: Duration,
    max: u32,
    buckets: std::sync::Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    fn new(window: Duration, max: u32) -> Self {
        Self {
            window,
            max,
            buckets: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// True if the request is within budget; false once the key is over it.
    fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap();
        // Opportunistic sweep so a churn of distinct keys can't grow the map
        // without bound.
        if buckets.len() > 4096 {
            buckets.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = buckets.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.max
    }
}

/// Rate-limit key for a request: the client IP. `run()` always serves with
/// connect info, so the peer address is present on every transport.
fn rate_key(peer: &SocketAddr) -> String {
    peer.ip().to_string()
}

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<Hub>,
    pub config: Arc<Config>,
    pub connections: Arc<ConnectionManager>,
    pub ui_dir: Option<std::path::PathBuf>,
    pub data_dir: std::path::PathBuf,
    /// How to restart the process after an import is staged. The headless
    /// server leaves this unset (the supervisor restarts it after exit 0);
    /// the desktop shell installs a relaunch here.
    pub restart_handler: Arc<std::sync::Mutex<Option<Box<dyn Fn() + Send + Sync>>>>,
    /// TTS output per message id (see [`SPEECH_CACHE_MAX`]).
    pub speech_cache: Arc<SpeechCache>,
    /// Per-client fixed-window limiter for the Google sign-in surface.
    pub auth_limiter: Arc<RateLimiter>,
    /// Per-client fixed-window limiter for the upload surface.
    pub upload_limiter: Arc<RateLimiter>,
}

impl AppState {
    /// Build the two rate limiters an [`AppState`] needs, with the standard
    /// windows/budgets. Kept here so every constructor (headless + desktop)
    /// wires the same policy.
    pub fn default_limiters() -> (Arc<RateLimiter>, Arc<RateLimiter>) {
        (
            Arc::new(RateLimiter::new(RATE_WINDOW, AUTH_RATE_MAX)),
            Arc::new(RateLimiter::new(RATE_WINDOW, UPLOAD_RATE_MAX)),
        )
    }
}

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, detail: &str) -> ApiError {
    (code, Json(json!({"detail": detail})))
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_string)
}

/// A UI credential is either the static owner token or a session token minted
/// by Google sign-in. Both act as the single owner (v1 is single-user), so the
/// username always comes from the config.
fn is_ui_token(state: &AppState, token: &str) -> bool {
    state.config.is_owner_token(token)
        || crate::auth::verify_session(token, &state.config.session_secret()).is_some()
}

fn require_owner(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> Result<String, ApiError> {
    let token = bearer(headers)
        .or_else(|| query.get("token").cloned())
        .unwrap_or_default();
    if is_ui_token(state, &token) {
        Ok(state.config.username())
    } else {
        Err(err(StatusCode::UNAUTHORIZED, "Authentication required"))
    }
}

/// Body cap for the multipart upload routes. Axum's default is 2 MB, which
/// silently rejects any photo-sized attachment before the handler runs; size
/// it to the configured per-file cap times the file count (plus slack for
/// text fields and multipart framing). The handler still enforces the exact
/// per-file limit. Computed at router build, so a runtime max_file_mb change
/// applies after restart.
fn upload_body_limit(state: &AppState) -> axum::extract::DefaultBodyLimit {
    let per_file = state.config.snapshot().max_file_mb as usize * 1024 * 1024;
    axum::extract::DefaultBodyLimit::max(per_file * MAX_FILES_PER_MESSAGE + 1024 * 1024)
}

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .route("/api/me", get(me))
        .route("/api/groups", get(list_groups).post(create_group))
        .route("/api/groups/order", put(reorder_groups))
        .route("/api/groups/{group_id}", delete(delete_group))
        .route("/api/groups/{group_id}/channels", post(create_channel))
        .route("/api/groups/{group_id}/channels/order", put(reorder_channels))
        .route(
            "/api/groups/{group_id}/channels/{channel_id}",
            patch(update_channel).delete(delete_channel),
        )
        .route("/api/groups/{group_id}/members", get(list_members).post(add_member))
        .route(
            "/api/groups/{group_id}/members/{member_type}/{member_id}",
            delete(remove_member),
        )
        .route(
            "/api/channels/{channel_id}/messages",
            get(list_messages).post(post_message),
        )
        .route(
            "/api/channels/{channel_id}/messages/upload",
            post(post_message_upload).layer(upload_body_limit(&state)),
        )
        .route(
            "/api/channels/{channel_id}/voice",
            post(post_voice_message).layer(upload_body_limit(&state)),
        )
        .route("/api/channels/{channel_id}/read", put(mark_read))
        .route("/api/messages/{message_id}", get(get_message))
        .route("/api/messages/{message_id}/speech", get(message_speech))
        .route("/api/threads", get(list_threads))
        .route("/api/threads/{thread_id}/read", put(mark_thread_read))
        .route("/api/channels/{channel_id}/stars", get(list_stars))
        .route(
            "/api/channels/{channel_id}/stars/{message_id}",
            put(star_message).delete(unstar_message),
        )
        .route("/api/channels/{channel_id}/pins", get(list_pins))
        .route(
            "/api/channels/{channel_id}/pins/{message_id}",
            put(pin_message).delete(unpin_message),
        )
        .route("/api/channels/{channel_id}/agents", get(channel_agents))
        .route("/api/channels/{channel_id}/activity", get(channel_activity))
        .route("/api/agents", get(available_agents))
        .route("/api/agents/{agent_id}", delete(forget_agent))
        .route("/api/files/{file_id}", get(get_file))
        .route("/api/connections", get(list_connections).post(add_connection))
        .route(
            "/api/connections/{name}",
            put(update_connection).delete(remove_connection),
        )
        .route("/api/instance", put(update_instance))
        .route("/api/export", get(export_data))
        .route(
            "/api/import",
            post(import_data).layer(axum::extract::DefaultBodyLimit::max(MAX_IMPORT_BYTES)),
        )
        .route("/api/pairing", get(list_pairing).post(create_pairing))
        .route("/api/pairing/{token}", delete(revoke_pairing))
        .route("/api/auth/config", get(auth_config))
        .route("/api/auth/google/start", get(google_start))
        .route("/api/auth/google/callback", get(google_callback))
        .route("/ws", get(ui_ws))
        .route("/agent/ws", get(agent_ws));
    if let Some(dir) = &state.ui_dir {
        app = app.fallback_service(
            tower_http::services::ServeDir::new(dir)
                .append_index_html_on_directories(true),
        );
    }
    app.with_state(state)
}

// ------------------------------------------------------------------ helpers

fn group_or_404(state: &AppState, group_id: &str) -> Result<Value, ApiError> {
    state
        .hub
        .store
        .group(group_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown group"))
}

fn channel_or_404(state: &AppState, channel_id: &str) -> Result<Value, ApiError> {
    state
        .hub
        .store
        .channel(channel_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown channel"))
}

fn group_payload(state: &AppState, group: &Value, username: &str) -> Value {
    let gid = group["id"].as_str().unwrap_or_default();
    let mut channels = state.hub.store.group_channels(gid);
    let ids: Vec<String> = channels
        .iter()
        .filter_map(|c| c["id"].as_str().map(String::from))
        .collect();
    let unreads = state.hub.store.unread_counts(username, &ids);
    for c in &mut channels {
        let cid = c["id"].as_str().unwrap_or_default();
        let unread = &unreads[cid];
        c["unread"] = unread["count"].clone();
        c["mentions"] = unread["mentions"].clone();
        c["last_read_id"] = unread["last_read_id"].clone();
    }
    let mut out = group.clone();
    out["channels"] = Value::Array(channels);
    out["role"] = json!("admin"); // single-user v1: the owner is always admin
    out
}

/// Basename only, control chars stripped, bounded length.
fn safe_filename(name: &str) -> String {
    let base = name.replace('\\', "/");
    let base = base.rsplit('/').next().unwrap_or("").trim();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"|?*".contains(*c))
        .take(120)
        .collect();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

/// Image MIME from magic bytes, or None for anything that isn't a recognized
/// image. Client-declared content types are unreliable (especially from mobile
/// pickers), and the stored mime drives both inline rendering in the UI and
/// the vision path on the agent side — so trust the bytes for images and fall
/// back to the client's declaration for everything else.
fn sniff_image_mime(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if data.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // ISO-BMFF image brands: HEIC (iPhone default), HEIF, AVIF.
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        return match &data[8..12] {
            b"heic" | b"heix" | b"hevc" => Some("image/heic"),
            b"heif" | b"mif1" | b"msf1" => Some("image/heif"),
            b"avif" | b"avis" => Some("image/avif"),
            _ => None,
        };
    }
    None
}

/// The mime to store for an upload: magic bytes for images, the client's
/// content-type otherwise.
fn attachment_mime(data: &[u8], declared: &str) -> String {
    sniff_image_mime(data)
        .map(str::to_string)
        .unwrap_or_else(|| declared.split(';').next().unwrap_or("").trim().to_string())
}

fn resolve_thread(
    state: &AppState,
    channel_id: &str,
    thread_id: Option<i64>,
) -> Result<Option<i64>, ApiError> {
    let Some(tid) = thread_id else { return Ok(None) };
    let root = state
        .hub
        .store
        .message(tid)
        .filter(|m| m["channel_id"] == channel_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    // Replying to a reply continues that message's thread.
    Ok(Some(root["thread_id"].as_i64().unwrap_or(tid)))
}

// ------------------------------------------------------------------ handlers

async fn me(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    Ok(Json(json!({
        "username": user,
        "version": env!("CARGO_PKG_VERSION"),
        // Voice features (voice notes, speak-aloud, live voice) need an
        // OPENAI_API_KEY in the server env; clients hide the controls without it.
        "voice": crate::voice::api_key().is_some(),
    })))
}

async fn list_groups(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    let groups: Vec<Value> = state
        .hub
        .store
        .list_groups()
        .iter()
        .map(|g| group_payload(&state, g, &user))
        .collect();
    Ok(Json(json!({"groups": groups})))
}

async fn create_group(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Group name required"));
    }
    let description = payload["description"].as_str().unwrap_or("").trim();
    let group = state.hub.store.create_group(&name, description, Some(&user));
    Ok(Json(group_payload(&state, &group, &user)))
}

async fn delete_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    state.hub.store.delete_group(&group_id);
    Ok(Json(json!({"ok": true})))
}

async fn create_channel(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Channel name required"));
    }
    let topic = payload["topic"].as_str().unwrap_or("").trim();
    Ok(Json(state.hub.store.create_channel(&group_id, &name, topic)))
}

async fn update_channel(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let channel = channel_or_404(&state, &channel_id)?;
    if channel["group_id"] != group_id.as_str() {
        return Err(err(StatusCode::NOT_FOUND, "Channel not in this group"));
    }
    let name = match payload.get("name").and_then(Value::as_str) {
        Some(n) => {
            let n = n.trim();
            if n.is_empty() {
                return Err(err(StatusCode::BAD_REQUEST, "Channel name can't be empty"));
            }
            Some(n.to_string())
        }
        None => None,
    };
    let topic = payload
        .get("topic")
        .and_then(Value::as_str)
        .map(|t| t.trim().to_string());
    let updated = state
        .hub
        .store
        .update_channel(&channel_id, name.as_deref(), topic.as_deref())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown channel"))?;
    Ok(Json(updated))
}

async fn reorder_groups(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let ids: Vec<String> = payload["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "ids array required"));
    }
    state.hub.store.reorder_groups(&ids);
    Ok(Json(json!({"ok": true})))
}

async fn reorder_channels(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    let ids: Vec<String> = payload["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "ids array required"));
    }
    state.hub.store.reorder_channels(&group_id, &ids);
    Ok(Json(json!({"ok": true})))
}

async fn delete_channel(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let channel = channel_or_404(&state, &channel_id)?;
    if channel["group_id"] != group_id.as_str() {
        return Err(err(StatusCode::NOT_FOUND, "Channel not in this group"));
    }
    state.hub.store.delete_channel(&channel_id);
    Ok(Json(json!({"ok": true})))
}

async fn list_members(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    let known: HashMap<String, String> = state
        .hub
        .store
        .known_agents()
        .iter()
        .filter_map(|a| {
            Some((a["id"].as_str()?.to_string(), a["name"].as_str()?.to_string()))
        })
        .collect();
    let mut members = state.hub.store.members(&group_id);
    for m in &mut members {
        if m["member_type"] == "agent" {
            let id = m["member_id"].as_str().unwrap_or_default();
            m["name"] = json!(known.get(id).cloned().unwrap_or_else(|| id.to_string()));
        }
    }
    Ok(Json(json!({"members": members})))
}

async fn add_member(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    let member_type = payload["member_type"].as_str().unwrap_or("");
    let member_id = payload["member_id"].as_str().unwrap_or("");
    let role = payload["role"].as_str().unwrap_or("member");
    if !["user", "agent"].contains(&member_type) {
        return Err(err(StatusCode::BAD_REQUEST, "member_type must be 'user' or 'agent'"));
    }
    if member_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "member_id required"));
    }
    if member_type == "agent" && state.hub.store.agent(member_id).is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "Unknown agent"));
    }
    let channel_id = payload["channel_id"].as_str().filter(|s| !s.is_empty());
    if let Some(cid) = channel_id {
        if member_type != "agent" {
            return Err(err(StatusCode::BAD_REQUEST, "Only agents can be scoped to one channel"));
        }
        if channel_or_404(&state, cid)?["group_id"] != group_id.as_str() {
            return Err(err(StatusCode::NOT_FOUND, "Channel not in this group"));
        }
    }
    state.hub.store.add_member(
        &group_id,
        member_type,
        member_id,
        if member_type == "user" { role } else { "member" },
        channel_id,
    );
    Ok(Json(json!({"ok": true})))
}

async fn remove_member(
    State(state): State<AppState>,
    Path((group_id, member_type, member_id)): Path<(String, String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    let channel_id = q.get("channel_id").map(String::as_str).filter(|s| !s.is_empty());
    let removed = state
        .hub
        .store
        .remove_member(&group_id, &member_type, &member_id, channel_id);
    Ok(Json(json!({"ok": removed})))
}

async fn list_messages(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    let thread_id = q.get("thread_id").and_then(|s| s.parse().ok());
    let before_id = q.get("before_id").and_then(|s| s.parse().ok());
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(50)
        .clamp(1, 200);
    Ok(Json(json!({
        "messages": state.hub.store.messages(&channel_id, thread_id, before_id, limit)
    })))
}

async fn post_message(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    let text = payload["text"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Message text required"));
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(err(StatusCode::BAD_REQUEST, "Message too long"));
    }
    let thread_id = resolve_thread(&state, &channel_id, payload["thread_id"].as_i64())?;
    let message = state
        .hub
        .post_user_message(&channel_id, &text, &user, None, thread_id, vec![]);
    Ok(Json(message))
}

async fn post_message_upload(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many uploads — slow down"));
    }
    channel_or_404(&state, &channel_id)?;
    let max_bytes = state.config.snapshot().max_file_mb as usize * 1024 * 1024;
    let mut text = String::new();
    let mut thread_id: Option<i64> = None;
    let mut attachments: Vec<NewAttachment> = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid upload"))?
    {
        match field.name().unwrap_or("") {
            "text" => text = field.text().await.unwrap_or_default().trim().to_string(),
            "thread_id" => {
                let raw = field.text().await.unwrap_or_default();
                if !raw.is_empty() {
                    thread_id = Some(
                        raw.parse()
                            .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid thread_id"))?,
                    );
                }
            }
            "files" => {
                if attachments.len() >= MAX_FILES_PER_MESSAGE {
                    return Err(err(StatusCode::BAD_REQUEST, "Too many files (max 5 per message)"));
                }
                let filename = safe_filename(field.file_name().unwrap_or("file"));
                let declared = field.content_type().unwrap_or("").to_string();
                let data = field
                    .bytes()
                    .await
                    .map_err(|_| err(StatusCode::BAD_REQUEST, "Upload read failed"))?;
                if data.is_empty() {
                    return Err(err(StatusCode::BAD_REQUEST, "Empty file upload"));
                }
                if data.len() > max_bytes {
                    return Err(err(StatusCode::BAD_REQUEST, "File too large"));
                }
                attachments.push(NewAttachment {
                    filename,
                    mime: attachment_mime(&data, &declared),
                    data: data.to_vec(),
                });
            }
            _ => {}
        }
    }
    if text.is_empty() && attachments.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Message text required"));
    }
    let thread_id = resolve_thread(&state, &channel_id, thread_id)?;
    let message = state
        .hub
        .post_user_message(&channel_id, &text, &user, None, thread_id, attachments);
    Ok(Json(message))
}

/// Voice input: transcribe an uploaded recording and post the transcript as a
/// normal user message (the audio itself is not stored). `live=true` marks a
/// hands-free live-voice turn: the fan-out tells member agents to answer in
/// spoken prose because the reply will be read aloud.
async fn post_voice_message(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many uploads — slow down"));
    }
    channel_or_404(&state, &channel_id)?;
    let Some(key) = crate::voice::api_key() else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Voice input needs OPENAI_API_KEY on the server (speech-to-text is not configured)",
        ));
    };
    let mut audio: Vec<u8> = Vec::new();
    let mut filename = String::new();
    let mut thread_id: Option<i64> = None;
    let mut live = false;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid upload"))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                filename = safe_filename(field.file_name().unwrap_or("voice-note.webm"));
                audio = field
                    .bytes()
                    .await
                    .map_err(|_| err(StatusCode::BAD_REQUEST, "Upload read failed"))?
                    .to_vec();
            }
            "thread_id" => {
                let raw = field.text().await.unwrap_or_default();
                if !raw.is_empty() {
                    thread_id = Some(
                        raw.parse()
                            .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid thread_id"))?,
                    );
                }
            }
            "live" => live = field.text().await.unwrap_or_default() == "true",
            _ => {}
        }
    }
    if audio.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Empty audio upload"));
    }
    if audio.len() > MAX_VOICE_BYTES {
        return Err(err(StatusCode::BAD_REQUEST, "Voice recording too large"));
    }
    let thread_id = resolve_thread(&state, &channel_id, thread_id)?;
    let text = tokio::task::spawn_blocking(move || crate::voice::transcribe(&key, &audio, &filename))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Transcription task failed"))?
        .map_err(|e| {
            tracing::error!("voice transcription failed: {e}");
            err(StatusCode::BAD_GATEWAY, "Transcription failed — try again")
        })?;
    if text.is_empty() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Couldn't hear anything in that recording",
        ));
    }
    let message = state
        .hub
        .post_user_message_opts(&channel_id, &text, &user, None, thread_id, vec![], live);
    Ok(Json(message))
}

/// Synthesize a message as speech for client playback (speak-aloud and live
/// voice). MP3 because Safari's `<audio>` can't decode Opus.
async fn message_speech(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_owner(&state, &headers, &q)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    let Some(key) = crate::voice::api_key() else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Spoken replies need OPENAI_API_KEY on the server (text-to-speech is not configured)",
        ));
    };
    let cached = {
        let mut cache = state.speech_cache.lock().unwrap();
        match cache.iter().position(|(id, _)| *id == message_id) {
            Some(i) => {
                let entry = cache.remove(i);
                let audio = entry.1.clone();
                cache.push(entry); // bump to most-recently-used
                Some(audio)
            }
            None => None,
        }
    };
    let audio = match cached {
        Some(audio) => audio,
        None => {
            let text = message["text"].as_str().unwrap_or_default().to_string();
            if crate::voice::clip_for_tts(&text).is_empty() {
                return Err(err(StatusCode::BAD_REQUEST, "Nothing to speak"));
            }
            let audio = tokio::task::spawn_blocking(move || crate::voice::synthesize(&key, &text))
                .await
                .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Speech task failed"))?
                .map_err(|e| {
                    tracing::error!("speech synthesis failed: {e}");
                    err(StatusCode::BAD_GATEWAY, "Speech synthesis failed — try again")
                })?;
            let mut cache = state.speech_cache.lock().unwrap();
            cache.retain(|(id, _)| *id != message_id);
            cache.push((message_id, audio.clone()));
            if cache.len() > SPEECH_CACHE_MAX {
                cache.remove(0);
            }
            audio
        }
    };
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert("content-type", "audio/mpeg".parse().unwrap());
    Ok((resp_headers, audio).into_response())
}

async fn get_file(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_owner(&state, &headers, &q)?;
    let meta = state
        .hub
        .store
        .file(&file_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown file"))?;
    let path = state.hub.store.file_path(&file_id);
    let data = std::fs::read(&path)
        .map_err(|_| err(StatusCode::NOT_FOUND, "File content missing"))?;
    let mime = meta["mime"].as_str().filter(|m| !m.is_empty()).unwrap_or("application/octet-stream");
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert("content-type", mime.parse().unwrap());
    if !mime.starts_with("image/") {
        let filename = meta["filename"].as_str().unwrap_or("file");
        resp_headers.insert(
            "content-disposition",
            format!("attachment; filename=\"{filename}\"").parse().unwrap(),
        );
    }
    Ok((resp_headers, data).into_response())
}

async fn mark_read(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    let last = state
        .hub
        .mark_read(&user, &channel_id, payload["last_read_id"].as_i64());
    Ok(Json(json!({"ok": true, "last_read_id": last})))
}

/// Single message fetch — lets clients open a thread whose root isn't in
/// their loaded window (threads inbox, old pins, deep links).
async fn get_message(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let mut message = state
        .hub
        .store
        .message(message_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if message["thread_id"].is_null() {
        message["reply_count"] = json!(state.hub.store.thread_size(message_id));
    }
    Ok(Json(message))
}

/// Threads inbox: every thread the user participates in, newest first.
async fn list_threads(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(100)
        .clamp(1, 500);
    Ok(Json(json!({"threads": state.hub.store.my_threads(&user, limit)})))
}

async fn mark_thread_read(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    state
        .hub
        .store
        .message(thread_id)
        .filter(|m| m["thread_id"].is_null())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    let last = state
        .hub
        .mark_thread_read(&user, thread_id, payload["last_read_id"].as_i64());
    Ok(Json(json!({"ok": true, "last_read_id": last})))
}

async fn list_stars(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    Ok(Json(json!({"stars": state.hub.store.user_stars(&user, &channel_id)})))
}

async fn star_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    let _ = message;
    state.hub.store.star_message(&user, &channel_id, message_id);
    Ok(Json(json!({"ok": true})))
}

async fn unstar_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    Ok(Json(json!({"ok": state.hub.store.unstar_message(&user, message_id)})))
}

async fn list_pins(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    Ok(Json(json!({"pins": state.hub.store.channel_pins(&channel_id)})))
}

async fn pin_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if !message["thread_id"].is_null() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Only top-level messages (thread roots) can be pinned",
        ));
    }
    if state.hub.store.pin_count(&channel_id) >= MAX_PINS_PER_CHANNEL {
        return Err(err(StatusCode::BAD_REQUEST, "Pin limit reached (25) — unpin something first"));
    }
    if state.hub.store.pin_message(&channel_id, message_id, Some(&user)) {
        let pin = state
            .hub
            .store
            .channel_pins(&channel_id)
            .into_iter()
            .find(|x| x["id"] == message_id);
        state.hub.post_transient(
            &channel_id,
            json!({"type": "pin", "channel_id": channel_id, "pinned": true, "pin": pin}),
        );
    }
    Ok(Json(json!({"ok": true})))
}

async fn unpin_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    if state.hub.store.unpin_message(&channel_id, message_id) {
        state.hub.post_transient(
            &channel_id,
            json!({"type": "pin", "channel_id": channel_id, "pinned": false, "message_id": message_id}),
        );
    }
    Ok(Json(json!({"ok": true})))
}

async fn channel_agents(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    Ok(Json(json!({"agents": state.hub.channel_agents(&channel_id)})))
}

async fn channel_activity(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    channel_or_404(&state, &channel_id)?;
    Ok(Json(state.hub.channel_activity(&channel_id)))
}

async fn available_agents(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let live = state.hub.live_agent_ids();
    let agents: Vec<Value> = state
        .hub
        .store
        .known_agents()
        .into_iter()
        .map(|mut a| {
            let id = a["id"].as_str().unwrap_or_default().to_string();
            a["live"] = json!(live.contains(&id));
            a["avatar"] = Value::Null;
            a
        })
        .collect();
    Ok(Json(json!({"agents": agents})))
}

async fn forget_agent(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    if state.hub.live_agent_ids().contains(&agent_id) {
        return Err(err(StatusCode::BAD_REQUEST, "Agent is currently connected"));
    }
    Ok(Json(json!({"ok": state.hub.store.remove_agent(&agent_id)})))
}

// ------------------------------------------------------------- connections

async fn list_connections(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let status: HashMap<String, Value> = state
        .connections
        .status()
        .into_iter()
        .map(|s| (s.name.clone(), serde_json::to_value(&s).unwrap_or(Value::Null)))
        .collect();
    let conns: Vec<Value> = state
        .config
        .snapshot()
        .connections
        .iter()
        .map(|c| {
            json!({
                "name": c.name, "url": c.url, "enabled": c.enabled,
                "status": status.get(&c.name).cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(Json(json!({
        "connections": conns,
        "instance": {
            "id": state.config.instance_id(),
            "name": state.config.instance_name(),
        },
    })))
}

/// Rename this app's declared identity. Linked endpoints learn the new name
/// through a reconnect (`identify` rides the handshake), so restart the loops.
async fn update_instance(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name required"));
    }
    state.config.update(|c| c.instance_name = name);
    state.connections.restart();
    Ok(Json(json!({"ok": true})))
}

// -------------------------------------------------------- export / import

async fn export_data(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_owner(&state, &headers, &q)?;
    let store = Arc::clone(&state.hub.store);
    let (id, name) = (state.config.instance_id(), state.config.instance_name());
    let bytes = tokio::task::spawn_blocking(move || crate::migrate::export_archive(&store, &id, &name))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "export task failed"))?
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &format!("export failed: {e}")))?;
    let filename = format!("agora-export-{}.tar.gz", crate::store::now() as u64);
    Ok((
        [
            ("content-type", "application/gzip".to_string()),
            (
                "content-disposition",
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

async fn import_data(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many uploads — slow down"));
    }
    let replace = matches!(
        q.get("replace").map(String::as_str),
        Some("1" | "true" | "yes")
    );
    if !replace && !state.hub.store.list_groups().is_empty() {
        return Err(err(
            StatusCode::CONFLICT,
            "This Agora already has data; pass ?replace=true to overwrite it",
        ));
    }
    let mut archive: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid upload"))?
    {
        if field.name().unwrap_or("") == "archive" {
            archive = Some(
                field
                    .bytes()
                    .await
                    .map_err(|_| err(StatusCode::BAD_REQUEST, "Upload interrupted"))?
                    .to_vec(),
            );
        }
    }
    let archive = archive.ok_or_else(|| err(StatusCode::BAD_REQUEST, "archive field required"))?;
    let data_dir = state.data_dir.clone();
    let manifest = tokio::task::spawn_blocking(move || crate::migrate::stage_import(&data_dir, &archive))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "import task failed"))?
        .map_err(|e| err(StatusCode::BAD_REQUEST, &format!("invalid archive: {e}")))?;

    // Give the response time to flush, then restart: the desktop shell
    // relaunches itself; the headless server exits 0 for its supervisor.
    let hook = Arc::clone(&state.restart_handler);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        if let Some(restart) = hook.lock().unwrap().as_ref() {
            restart();
        }
        std::process::exit(0);
    });
    Ok(Json(json!({
        "staged": true,
        "manifest": manifest,
        "detail": "Import staged; restarting to apply it.",
    })))
}

async fn add_connection(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    let url = payload["url"].as_str().unwrap_or("").trim().to_string();
    let token = payload["token"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() || url.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name and url required"));
    }
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        return Err(err(StatusCode::BAD_REQUEST, "url must be ws:// or wss://"));
    }
    let exists = state
        .config
        .snapshot()
        .connections
        .iter()
        .any(|c| c.name == name);
    if exists {
        return Err(err(StatusCode::BAD_REQUEST, "A connection with that name exists"));
    }
    state.config.update(|c| {
        c.connections.push(Connection {
            name,
            url,
            token,
            enabled: true,
        })
    });
    state.connections.sync();
    Ok(Json(json!({"ok": true})))
}

async fn update_connection(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let mut found = false;
    state.config.update(|c| {
        for conn in &mut c.connections {
            if conn.name == name {
                found = true;
                if let Some(url) = payload["url"].as_str() {
                    conn.url = url.trim().to_string();
                }
                if let Some(token) = payload["token"].as_str() {
                    if !token.is_empty() {
                        conn.token = token.trim().to_string();
                    }
                }
                if let Some(enabled) = payload["enabled"].as_bool() {
                    conn.enabled = enabled;
                }
            }
        }
    });
    if !found {
        return Err(err(StatusCode::NOT_FOUND, "Unknown connection"));
    }
    state.connections.sync();
    Ok(Json(json!({"ok": true})))
}

async fn remove_connection(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    state.config.update(|c| c.connections.retain(|x| x.name != name));
    state.connections.sync();
    Ok(Json(json!({"ok": true})))
}

async fn list_pairing(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    Ok(Json(json!({"tokens": state.config.snapshot().pairing_tokens})))
}

async fn create_pairing(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    let name = payload["name"].as_str().unwrap_or("bridge").trim().to_string();
    let token = new_token();
    state.config.update(|c| {
        c.pairing_tokens.push(PairingToken {
            token: token.clone(),
            name,
            created_at: now(),
        })
    });
    Ok(Json(json!({"token": token})))
}

async fn revoke_pairing(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers, &q)?;
    state.config.update(|c| c.pairing_tokens.retain(|t| t.token != token));
    Ok(Json(json!({"ok": true})))
}

// ----------------------------------------------------------- google sign-in

/// Short-lived CSRF cookie binding a Google round-trip to the browser that
/// started it; scoped to the auth routes.
const OAUTH_STATE_COOKIE: &str = "agora_oauth_state";
const OAUTH_STATE_MAX_AGE: u32 = 600;

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|pair| {
            let (k, v) = pair.trim().split_once('=')?;
            (k == name).then(|| v.to_string())
        })
}

/// The Google callback URL: `public_url` wins (deterministic behind a proxy);
/// otherwise derive it from the inbound request's Host header.
fn oauth_redirect_uri(state: &AppState, headers: &HeaderMap) -> String {
    let base = state.config.public_url();
    let base = if base.is_empty() {
        let host = headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost");
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("http");
        format!("{scheme}://{host}")
    } else {
        base
    };
    format!("{base}/api/auth/google/callback")
}

fn set_state_cookie(secure: bool, state: &str, max_age: u32) -> String {
    format!(
        "{OAUTH_STATE_COOKIE}={state}; Max-Age={max_age}; Path=/api/auth; HttpOnly; SameSite=Lax{}",
        if secure { "; Secure" } else { "" }
    )
}

fn redirect_with_cookie(url: &str, cookie: String) -> Response {
    (
        StatusCode::FOUND,
        [("location", url.to_string()), ("set-cookie", cookie)],
    )
        .into_response()
}

/// Which sign-in methods this instance offers; the login surfaces (web auth
/// gate, desktop connect page, mobile connect screen) probe this before
/// showing a Google button. Unauthenticated by design — it only reveals
/// whether the button exists.
async fn auth_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "google": {"enabled": state.config.google().is_some()},
    }))
}

/// Step 1: bounce the browser to Google's consent screen. `?next=` says where
/// the callback should deliver the session token — the web UI by default, or
/// an allowlisted client target (desktop loopback listener / mobile deep link).
async fn google_start(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !state.auth_limiter.allow(&rate_key(&peer)) {
        return err(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts — slow down")
            .into_response();
    }
    let Some(gc) = state.config.google() else {
        return err(StatusCode::NOT_FOUND, "Google sign-in is not enabled").into_response();
    };
    let next = q.get("next").cloned().unwrap_or_else(|| "/".to_string());
    if next != "/" && !crate::auth::allowed_next(&next) {
        return err(StatusCode::BAD_REQUEST, "next target is not allowed").into_response();
    }
    let oauth_state = crate::auth::encode_state(&next);
    let redirect_uri = oauth_redirect_uri(&state, &headers);
    // `?select_account=1` lets a client force the account chooser (e.g. a
    // retry after the allowlist rejected the silently-reused account).
    let select_account = q.get("select_account").map(String::as_str) == Some("1");
    let url = crate::auth::build_consent_url(&gc, &redirect_uri, &oauth_state, select_account);
    let secure = redirect_uri.starts_with("https://");
    redirect_with_cookie(&url, set_state_cookie(secure, &oauth_state, OAUTH_STATE_MAX_AGE))
}

/// Step 2: Google bounced back. Verify CSRF state, exchange the code for an
/// id_token over the TLS back-channel, check its claims + the email
/// allowlist, then deliver a freshly minted session token to `next`.
async fn google_callback(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !state.auth_limiter.allow(&rate_key(&peer)) {
        return err(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts — slow down")
            .into_response();
    }
    let state_param = q.get("state").cloned().unwrap_or_default();
    let next = crate::auth::next_from_state(&state_param);
    let secure = oauth_redirect_uri(&state, &headers).starts_with("https://");

    // Failures land where the flow started: the web UI reads the fragment,
    // client listeners read ?error=.
    let land_err = |reason: &str| -> Response {
        let url = match &next {
            Some(n) if n != "/" => format!(
                "{n}{}error={}",
                if n.contains('?') { "&" } else { "?" },
                crate::auth::urlencode(reason)
            ),
            _ => format!("/#auth_error={}", crate::auth::urlencode(reason)),
        };
        redirect_with_cookie(&url, set_state_cookie(secure, "", 0))
    };

    let Some(gc) = state.config.google() else {
        return land_err("google_disabled");
    };
    if let Some(e) = q.get("error") {
        // Google-side refusal, e.g. access_denied from an unconsenting user.
        tracing::warn!("google sign-in returned error={e}");
        return land_err(&format!("google_{e}"));
    }
    let code = q.get("code").cloned().unwrap_or_default();
    if code.is_empty() {
        return land_err("no_code");
    }
    let cookie = cookie_value(&headers, OAUTH_STATE_COOKIE).unwrap_or_default();
    if cookie.is_empty() || !crate::auth::state_matches(&cookie, &state_param) {
        tracing::warn!("google sign-in: CSRF state mismatch");
        return land_err("state");
    }
    let redirect_uri = oauth_redirect_uri(&state, &headers);
    let exchange = {
        let gc = gc.clone();
        tokio::task::spawn_blocking(move || {
            crate::auth::exchange_code(&gc, &code, &redirect_uri)
        })
        .await
    };
    let email = match exchange {
        Ok(Ok(tokens)) => {
            let id_token = tokens["id_token"].as_str().unwrap_or_default();
            match crate::auth::decode_id_token(id_token, &gc) {
                Ok(email) => email,
                Err(e) => {
                    tracing::warn!("google sign-in: id_token rejected: {e}");
                    return land_err(if e.to_string().contains("allowlist") {
                        "no_access"
                    } else {
                        "token"
                    });
                }
            }
        }
        _ => {
            tracing::warn!("google sign-in: token exchange failed");
            return land_err("token");
        }
    };
    tracing::info!("google sign-in: {email} accepted");
    let session = crate::auth::mint_session(
        &state.config.username(),
        &state.config.session_secret(),
    );
    let url = match &next {
        Some(n) if n != "/" => format!(
            "{n}{}token={}",
            if n.contains('?') { "&" } else { "?" },
            crate::auth::urlencode(&session)
        ),
        _ => format!("/#agora_session={}", crate::auth::urlencode(&session)),
    };
    redirect_with_cookie(&url, set_state_cookie(secure, "", 0))
}

// ------------------------------------------------------------- websockets

async fn ui_ws(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    // Browsers can't set headers on a websocket, so auth rides on ?token=.
    let token = q.get("token").cloned().unwrap_or_default();
    if !is_ui_token(&state, &token) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    ws.on_upgrade(move |socket| handle_ui_socket(state, socket))
}

async fn handle_ui_socket(state: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = unbounded_channel::<Value>();
    let socket_id = state.hub.attach_socket(&state.config.username(), true, tx);
    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(v) => {
                        if sink.send(WsMessage::Text(v.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    // Inbound frames are ignored (clients post via REST);
                    // receiving keeps the connection alive and surfaces closes.
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    state.hub.detach_socket(socket_id);
}

async fn agent_ws(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let token = q.get("token").cloned().unwrap_or_default();
    let Some(source) = state.config.valid_pairing_token(&token) else {
        return (StatusCode::UNAUTHORIZED, "bad pairing token").into_response();
    };
    ws.on_upgrade(move |socket| handle_agent_socket(state, socket, source))
}

/// Dial-in bridge: the agent speaks first with `hello {agents: [...]}`,
/// then the same frame protocol as an outbound connection.
async fn handle_agent_socket(state: AppState, socket: WebSocket, source: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = unbounded_channel::<Value>();
    let conn_id = state.hub.next_conn_id();
    let mut registered = false;
    loop {
        tokio::select! {
            event = rx.recv() => {
                match event {
                    Some(v) => {
                        if sink.send(WsMessage::Text(v.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                        if frame["type"] == "hello" {
                            for a in frame["agents"].as_array().cloned().unwrap_or_default() {
                                let Some(id) = a["id"].as_str() else { continue };
                                state.hub.register_agent(AgentHandle {
                                    agent_id: id.to_string(),
                                    agent_name: a["name"].as_str().unwrap_or(id).to_string(),
                                    requires_mention: a["requires_mention"].as_bool().unwrap_or(false),
                                    source: format!("pairing:{source}"),
                                    conn_id,
                                    tx: tx.clone(),
                                });
                                registered = true;
                            }
                        } else if registered {
                            state.hub.handle_agent_frame(&frame);
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    state.hub.unregister_connection(conn_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_recognizes_classic_web_formats() {
        assert_eq!(sniff_image_mime(b"\x89PNG\r\n\x1a\n\x00\x00"), Some("image/png"));
        assert_eq!(sniff_image_mime(b"\xff\xd8\xff\xe0rest"), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a......"), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));
    }

    #[test]
    fn sniff_recognizes_iso_bmff_image_brands() {
        assert_eq!(sniff_image_mime(b"\x00\x00\x00\x18ftypheic\x00\x00"), Some("image/heic"));
        assert_eq!(sniff_image_mime(b"\x00\x00\x00\x18ftypmif1\x00\x00"), Some("image/heif"));
        assert_eq!(sniff_image_mime(b"\x00\x00\x00\x18ftypavif\x00\x00"), Some("image/avif"));
        // Video brands are not images.
        assert_eq!(sniff_image_mime(b"\x00\x00\x00\x18ftypisom\x00\x00"), None);
    }

    #[test]
    fn sniff_rejects_non_images_and_short_input() {
        assert_eq!(sniff_image_mime(b"plain text"), None);
        assert_eq!(sniff_image_mime(b""), None);
        assert_eq!(sniff_image_mime(b"RIFF"), None);
    }

    #[test]
    fn attachment_mime_trusts_bytes_over_declaration() {
        // A HEIC upload declared as octet-stream still stores as image/heic.
        assert_eq!(
            attachment_mime(b"\x00\x00\x00\x18ftypheic\x00\x00", "application/octet-stream"),
            "image/heic"
        );
        // A JPEG mislabeled as png corrects to jpeg.
        assert_eq!(attachment_mime(b"\xff\xd8\xff\xe0rest", "image/png"), "image/jpeg");
        // Non-images keep the declared type, parameters stripped.
        assert_eq!(attachment_mime(b"%PDF-1.7", "application/pdf; name=x"), "application/pdf");
    }
}
