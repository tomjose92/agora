//! The app's HTTP + WebSocket surface (axum).
//!
//! - `/api/*` — the UI's REST API (admin-key auth; single-user v1).
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
/// Distinct emoji per message — bounds the chip row like Slack does.
const MAX_REACTION_KINDS_PER_MESSAGE: usize = 20;

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

/// The resolved caller of an API request or UI socket.
#[derive(Clone)]
pub struct AuthedUser {
    pub username: String,
    pub display_name: String,
    pub instance_admin: bool,
}

/// Resolve a UI credential to a user. Two kinds exist:
///
/// - the static **admin key** — the operator credential (printed in the
///   server log, used by the desktop shell and automation). It acts as the
///   bootstrap account (`config.username`) with instance-admin powers, even
///   if that account row was deleted.
/// - a **session token** minted by Google/Apple sign-in — resolved to its
///   user row; rejected when the account is missing, disabled, or its
///   session version was bumped (per-user sign-out).
fn authed_user(state: &AppState, token: &str) -> Option<AuthedUser> {
    if state.config.is_admin_key(token) {
        let username = state.config.username();
        let display_name = state
            .hub
            .store
            .user(&username)
            .and_then(|u| u["display_name"].as_str().map(str::to_string))
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| username.clone());
        return Some(AuthedUser {
            username,
            display_name,
            instance_admin: true,
        });
    }
    let (username, version) =
        crate::auth::verify_session(token, &state.config.session_secret())?;
    let user = state.hub.store.user(&username)?;
    if user["disabled"].as_bool().unwrap_or(false) {
        return None;
    }
    if user["session_version"].as_i64().unwrap_or(1) != version {
        return None;
    }
    let display_name = user["display_name"]
        .as_str()
        .filter(|d| !d.is_empty())
        .unwrap_or(&username)
        .to_string();
    Some(AuthedUser {
        instance_admin: user["instance_role"] == "admin",
        username,
        display_name,
    })
}

fn require_user(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> Result<AuthedUser, ApiError> {
    let token = bearer(headers)
        .or_else(|| query.get("token").cloned())
        .unwrap_or_default();
    authed_user(state, &token)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Authentication required"))
}

fn require_instance_admin(user: &AuthedUser) -> Result<(), ApiError> {
    if user.instance_admin {
        Ok(())
    } else {
        Err(err(StatusCode::FORBIDDEN, "Instance admin access required"))
    }
}

/// Membership is the visibility boundary: users are group-scoped in v1.
/// Instance admins bypass it (they are the operator).
fn require_member(state: &AppState, user: &AuthedUser, group_id: &str) -> Result<(), ApiError> {
    if user.instance_admin || state.hub.store.user_in_group(&user.username, group_id) {
        Ok(())
    } else {
        Err(err(StatusCode::FORBIDDEN, "You are not a member of this group"))
    }
}

fn require_group_admin(
    state: &AppState,
    user: &AuthedUser,
    group_id: &str,
) -> Result<(), ApiError> {
    if user.instance_admin || state.hub.store.user_is_group_admin(&user.username, group_id) {
        Ok(())
    } else {
        Err(err(StatusCode::FORBIDDEN, "Group admin access required"))
    }
}

/// The channel if it exists *and* the caller may see it (member of its
/// group). Most message-path handlers start here.
fn require_channel_member(
    state: &AppState,
    user: &AuthedUser,
    channel_id: &str,
) -> Result<Value, ApiError> {
    let channel = channel_or_404(state, channel_id)?;
    require_member(state, user, channel["group_id"].as_str().unwrap_or_default())?;
    Ok(channel)
}

/// Message lookup gated the same way as [`require_channel_member`].
fn require_message_visible(
    state: &AppState,
    user: &AuthedUser,
    message_id: i64,
) -> Result<Value, ApiError> {
    let message = state
        .hub
        .store
        .message(message_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    require_channel_member(state, user, message["channel_id"].as_str().unwrap_or_default())?;
    Ok(message)
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
        .route("/api/me", get(me).patch(update_me).delete(delete_me))
        .route("/api/users", get(list_users))
        .route("/api/users/{username}", patch(update_user))
        .route("/api/invites", get(list_invites).post(create_invite))
        .route("/api/invites/{email}", delete(revoke_invite))
        .route("/join/{token}", get(join_link))
        .route("/api/groups", get(list_groups).post(create_group))
        .route("/api/groups/order", put(reorder_groups))
        .route("/api/groups/{group_id}", patch(update_group).delete(delete_group))
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
        .route("/api/messages/{message_id}/select", post(select_message_option))
        .route("/api/messages/{message_id}/speech", get(message_speech))
        .route("/api/search", get(search))
        .route("/api/search/ask", post(search_ask))
        .route("/api/threads", get(list_threads))
        .route("/api/threads/{thread_id}", patch(update_thread))
        .route("/api/threads/{thread_id}/read", put(mark_thread_read))
        .route(
            "/api/threads/{thread_id}/hide",
            put(hide_thread).delete(unhide_thread),
        )
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
        .route(
            "/api/channels/{channel_id}/messages/{message_id}/reactions/{emoji}",
            put(add_reaction).delete(remove_reaction),
        )
        .route("/api/channels/{channel_id}/agents", get(channel_agents))
        .route("/api/channels/{channel_id}/activity", get(channel_activity))
        .route("/api/agents", get(available_agents))
        .route("/api/agents/{agent_id}", delete(forget_agent))
        .route("/api/agents/{agent_id}/avatar", get(agent_avatar))
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
        .route("/api/push-tokens", post(register_push_token).delete(unregister_push_token))
        .route("/api/auth/config", get(auth_config))
        .route("/api/auth/google/start", get(google_start))
        .route("/api/auth/google/callback", get(google_callback))
        .route("/api/auth/apple", post(apple_signin))
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

/// Overlay one user's sidebar prefs onto a list of groups or channels:
/// `hidden` becomes *their* flag (the legacy global column is ignored), and
/// items they manually ordered sort first; the rest keep the store's order.
fn overlay_prefs(items: Vec<Value>, prefs: &std::collections::HashMap<String, (bool, Option<i64>)>) -> Vec<Value> {
    let mut indexed: Vec<(usize, Value)> = items
        .into_iter()
        .map(|mut item| {
            let id = item["id"].as_str().unwrap_or_default();
            item["hidden"] = json!(prefs.get(id).map(|p| p.0).unwrap_or(false));
            item
        })
        .enumerate()
        .collect();
    indexed.sort_by_key(|(i, item)| {
        let id = item["id"].as_str().unwrap_or_default();
        (prefs.get(id).and_then(|p| p.1).unwrap_or(i64::MAX), *i)
    });
    indexed.into_iter().map(|(_, item)| item).collect()
}

fn group_payload(state: &AppState, group: &Value, user: &AuthedUser) -> Value {
    let gid = group["id"].as_str().unwrap_or_default();
    let chan_prefs = state.hub.store.user_prefs(&user.username, "channel");
    let mut channels = overlay_prefs(state.hub.store.group_channels(gid), &chan_prefs);
    let ids: Vec<String> = channels
        .iter()
        .filter_map(|c| c["id"].as_str().map(String::from))
        .collect();
    let unreads = state.hub.store.unread_counts(&user.username, &ids);
    for c in &mut channels {
        let cid = c["id"].as_str().unwrap_or_default();
        let unread = &unreads[cid];
        c["unread"] = unread["count"].clone();
        c["mentions"] = unread["mentions"].clone();
        c["last_read_id"] = unread["last_read_id"].clone();
    }
    let mut out = group.clone();
    // Hiding is personal: report the caller's flag, not the legacy global.
    let group_prefs = state.hub.store.user_prefs(&user.username, "group");
    out["hidden"] = json!(group_prefs.get(gid).map(|p| p.0).unwrap_or(false));
    out["channels"] = Value::Array(channels);
    let admin =
        user.instance_admin || state.hub.store.user_is_group_admin(&user.username, gid);
    out["role"] = json!(if admin { "admin" } else { "member" });
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
    let user = require_user(&state, &headers, &q)?;
    Ok(Json(json!({
        "username": user.username,
        "display_name": user.display_name,
        "instance_admin": user.instance_admin,
        "version": env!("CARGO_PKG_VERSION"),
        // Voice features (voice notes, speak-aloud, live voice) need an
        // OPENAI_API_KEY in the server env; clients hide the controls without it.
        "voice": crate::voice::api_key().is_some(),
        // AI search answers (/api/search/ask) need an ANTHROPIC_API_KEY in the
        // server env; clients hide their "Ask AI" controls without it.
        "search_ai": crate::ai::api_key().is_some(),
    })))
}

/// Profile self-service: the caller edits their own display name. Roles,
/// email and disabled stay admin-only on PATCH /api/users/{username}.
async fn update_me(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let Some(display_name) = payload["display_name"].as_str() else {
        return Err(err(StatusCode::BAD_REQUEST, "display_name required"));
    };
    // '' clears the name back to the username; cap it like a channel name.
    let display_name: String = display_name.trim().chars().take(80).collect();
    state
        .hub
        .store
        .set_user_display_name(&user.username, &display_name);
    let shown = if display_name.is_empty() { user.username.clone() } else { display_name };
    Ok(Json(json!({
        "username": user.username,
        "display_name": shown,
        "instance_admin": user.instance_admin,
    })))
}

/// Account deletion (App Store guideline 5.1.1(v)): erase everything keyed
/// to the caller (authored messages + their attachments, stars, reads,
/// pins, mentions, memberships) including the account row itself — which
/// revokes every session the user holds, since session verification needs
/// a live account. The admin key survives: it is the instance's operator
/// credential (printed in the server log), not a user account.
async fn delete_me(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let store = state.hub.store.clone();
    let username = user.username.clone();
    tokio::task::spawn_blocking(move || store.delete_user_data(&username))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Deletion failed"))?;
    tracing::info!("account data for {} deleted; sessions revoked", user.username);
    Ok(Json(json!({"ok": true})))
}

// ------------------------------------------------------------ users / invites

/// The workspace roster. Any signed-in user may read it (it feeds the
/// members panel's people picker, like Slack's member list); mutations are
/// instance-admin only.
async fn list_users(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_user(&state, &headers, &q)?;
    let users: Vec<Value> = state
        .hub
        .store
        .list_users()
        .into_iter()
        .map(|u| {
            json!({
                "username": u["username"],
                "display_name": u["display_name"],
                "email": u["email"],
                "instance_role": u["instance_role"],
                "created_at": u["created_at"],
                "disabled": u["disabled"],
            })
        })
        .collect();
    Ok(Json(json!({"users": users})))
}

/// Instance-admin account management: disable/enable a user (disabling also
/// revokes their sessions) or change their instance role.
async fn update_user(
    State(state): State<AppState>,
    Path(username): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let caller = require_user(&state, &headers, &q)?;
    require_instance_admin(&caller)?;
    let store = &state.hub.store;
    if store.user(&username).is_none() {
        return Err(err(StatusCode::NOT_FOUND, "Unknown user"));
    }
    if let Some(disabled) = payload["disabled"].as_bool() {
        if username == caller.username && disabled {
            return Err(err(StatusCode::BAD_REQUEST, "You can't disable your own account"));
        }
        store.set_user_disabled(&username, disabled);
        if disabled {
            store.bump_session_version(&username);
        }
    }
    if let Some(role) = payload["instance_role"].as_str() {
        if !["admin", "member"].contains(&role) {
            return Err(err(StatusCode::BAD_REQUEST, "instance_role must be 'admin' or 'member'"));
        }
        if username == caller.username && role != "admin" {
            return Err(err(StatusCode::BAD_REQUEST, "You can't demote your own account"));
        }
        store.set_user_instance_role(&username, role);
    }
    let user = store.user(&username).unwrap_or(Value::Null);
    Ok(Json(json!({
        "username": user["username"],
        "display_name": user["display_name"],
        "email": user["email"],
        "instance_role": user["instance_role"],
        "created_at": user["created_at"],
        "disabled": user["disabled"],
    })))
}

async fn list_invites(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = require_user(&state, &headers, &q)?;
    require_instance_admin(&caller)?;
    let links: Vec<Value> = state
        .hub
        .store
        .list_invite_links()
        .into_iter()
        .map(|mut l| {
            let token = l["token"].as_str().unwrap_or_default();
            l["url"] = json!(join_url(&state, token));
            l
        })
        .collect();
    Ok(Json(json!({
        "invites": state.hub.store.list_invites(),
        "links": links,
    })))
}

/// How long a shareable invite link can sit unused.
const INVITE_LINK_TTL_SECS: f64 = 7.0 * 24.0 * 3600.0;

/// The absolute /join URL for an invite-link token, based on the configured
/// public URL when there is one.
fn join_url(state: &AppState, token: &str) -> String {
    let base = state.config.public_url();
    if base.is_empty() {
        format!("/join/{token}")
    } else {
        format!("{base}/join/{token}")
    }
}

/// Invite a person. Two modes: `{"email": …}` keys the invite to an exact
/// address (no mail is sent — they just sign in with it), while
/// `{"link": true}` mints a single-use, expiring URL to hand to anyone.
async fn create_invite(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let caller = require_user(&state, &headers, &q)?;
    require_instance_admin(&caller)?;
    let role = payload["instance_role"].as_str().unwrap_or("member");
    if !["admin", "member"].contains(&role) {
        return Err(err(StatusCode::BAD_REQUEST, "instance_role must be 'admin' or 'member'"));
    }
    if payload["link"].as_bool() == Some(true) {
        let mut link = state.hub.store.create_invite_link(
            Some(&caller.username),
            role,
            INVITE_LINK_TTL_SECS,
        );
        let token = link["token"].as_str().unwrap_or_default();
        link["url"] = json!(join_url(&state, token));
        return Ok(Json(link));
    }
    let email = payload["email"].as_str().unwrap_or("").trim().to_lowercase();
    if state.hub.store.user_by_email(&email).is_some() {
        return Err(err(StatusCode::CONFLICT, "That email already has an account"));
    }
    let invite = state
        .hub
        .store
        .create_invite(&email, Some(&caller.username), role)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "A valid email is required"))?;
    Ok(Json(invite))
}

/// Revoke a pending invite: the path segment is an email for address
/// invites, or a link token (no '@') for link invites.
async fn revoke_invite(
    State(state): State<AppState>,
    Path(email): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = require_user(&state, &headers, &q)?;
    require_instance_admin(&caller)?;
    let ok = if email.contains('@') {
        state.hub.store.delete_invite(&email)
    } else {
        state.hub.store.delete_invite_link(&email)
    };
    Ok(Json(json!({"ok": ok})))
}

/// Landing for a shared invite link: bounce to the web UI with the token in
/// the fragment; the auth gate carries it through sign-in. Expired or used
/// links land with an explanatory error instead.
async fn join_link(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Response {
    let target = if state.hub.store.valid_invite_link(&token).is_some() {
        format!("/#join={}", crate::auth::urlencode(&token))
    } else {
        "/#auth_error=invite_invalid".to_string()
    };
    (StatusCode::FOUND, [("location", target)]).into_response()
}

/// The caller's groups only; instance admins (the operator) see all.
async fn list_groups(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let mine: Vec<Value> = state
        .hub
        .store
        .list_groups()
        .into_iter()
        .filter(|g| {
            user.instance_admin
                || state
                    .hub
                    .store
                    .user_in_group(&user.username, g["id"].as_str().unwrap_or_default())
        })
        .collect();
    // The caller's personal order (their reorder drags), not the global one.
    let prefs = state.hub.store.user_prefs(&user.username, "group");
    let groups: Vec<Value> = overlay_prefs(mine, &prefs)
        .iter()
        .map(|g| group_payload(&state, g, &user))
        .collect();
    Ok(Json(json!({"groups": groups})))
}

/// Any user may create a group; the creator becomes its (group) admin.
async fn create_group(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Group name required"));
    }
    let description = payload["description"].as_str().unwrap_or("").trim();
    let group = state
        .hub
        .store
        .create_group(&name, description, Some(&user.username));
    Ok(Json(group_payload(&state, &group, &user)))
}

/// Update a group's presentation flags — today just `hidden`, which tucks
/// the group away in *the caller's* sidebar (a personal pref, so any member
/// may set it) without touching its data.
async fn update_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let group = group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    let Some(hidden) = payload["hidden"].as_bool() else {
        return Err(err(StatusCode::BAD_REQUEST, "hidden (bool) required"));
    };
    state
        .hub
        .store
        .set_pref_hidden(&user.username, "group", &group_id, hidden);
    Ok(Json(group_payload(&state, &group, &user)))
}

async fn delete_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_group_admin(&state, &user, &group_id)?;
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
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_group_admin(&state, &user, &group_id)?;
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
    let user = require_user(&state, &headers, &q)?;
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
    let hidden = payload.get("hidden").and_then(Value::as_bool);
    // Rename/topic edit the shared channel (group admins); hiding is the
    // caller's personal sidebar pref (any member).
    if name.is_some() || topic.is_some() {
        require_group_admin(&state, &user, &group_id)?;
    } else {
        require_member(&state, &user, &group_id)?;
    }
    if let Some(h) = hidden {
        state
            .hub
            .store
            .set_pref_hidden(&user.username, "channel", &channel_id, h);
    }
    let mut updated = if name.is_some() || topic.is_some() {
        state
            .hub
            .store
            .update_channel(&channel_id, name.as_deref(), topic.as_deref(), None)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown channel"))?
    } else {
        channel_or_404(&state, &channel_id)?
    };
    let prefs = state.hub.store.user_prefs(&user.username, "channel");
    updated["hidden"] = json!(prefs.get(channel_id.as_str()).map(|p| p.0).unwrap_or(false));
    Ok(Json(updated))
}

/// Sidebar ordering is a personal pref: the drag order lands in the
/// caller's own prefs, nobody else's sidebar moves.
async fn reorder_groups(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let ids: Vec<String> = payload["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "ids array required"));
    }
    state.hub.store.set_pref_positions(&user.username, "group", &ids);
    Ok(Json(json!({"ok": true})))
}

async fn reorder_channels(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    let ids: Vec<String> = payload["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "ids array required"));
    }
    state.hub.store.set_pref_positions(&user.username, "channel", &ids);
    Ok(Json(json!({"ok": true})))
}

async fn delete_channel(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let channel = channel_or_404(&state, &channel_id)?;
    if channel["group_id"] != group_id.as_str() {
        return Err(err(StatusCode::NOT_FOUND, "Channel not in this group"));
    }
    require_group_admin(&state, &user, &group_id)?;
    state.hub.store.delete_channel(&channel_id);
    Ok(Json(json!({"ok": true})))
}

async fn list_members(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
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
        let id = m["member_id"].as_str().unwrap_or_default();
        if m["member_type"] == "agent" {
            m["name"] = json!(known.get(id).cloned().unwrap_or_else(|| id.to_string()));
        } else {
            let display = state
                .hub
                .store
                .user(id)
                .and_then(|u| u["display_name"].as_str().map(str::to_string))
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| id.to_string());
            m["name"] = json!(display);
        }
    }
    Ok(Json(json!({"members": members})))
}

/// Add a person or an agent to the group (group admins only). Re-adding an
/// existing user member with a different role updates the role — this is
/// also the promote/demote API.
async fn add_member(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_group_admin(&state, &user, &group_id)?;
    let member_type = payload["member_type"].as_str().unwrap_or("");
    let member_id = payload["member_id"].as_str().unwrap_or("");
    let role = payload["role"].as_str().unwrap_or("member");
    if !["user", "agent"].contains(&member_type) {
        return Err(err(StatusCode::BAD_REQUEST, "member_type must be 'user' or 'agent'"));
    }
    if member_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "member_id required"));
    }
    if !["member", "admin"].contains(&role) {
        return Err(err(StatusCode::BAD_REQUEST, "role must be 'member' or 'admin'"));
    }
    if member_type == "agent" && state.hub.store.agent(member_id).is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "Unknown agent"));
    }
    if member_type == "user" && state.hub.store.user(member_id).is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "Unknown user"));
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
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    // Group admins manage the roster; anyone may remove *themselves* (leave).
    let leaving = member_type == "user" && member_id == user.username;
    if !leaving {
        require_group_admin(&state, &user, &group_id)?;
    }
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
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
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

/// GET /api/search — full-text search over message text plus name/topic
/// matches on channels and groups, for the search UIs. `q` is required.
/// `limit` (default 20, cap 50) and `offset` page the message hits;
/// `channel_id` / `group_id` / `author` narrow the scope; `sort=new` orders
/// newest-first instead of best-match (bm25); `match=any` widens to
/// any-term recall (default: all terms); `types` picks result kinds
/// (comma list of `messages,channels,groups`, default all three).
/// `has_files=1` keeps only messages carrying an attachment and `file_type`
/// (`image`/`video`/`audio`/`pdf`/`doc`) narrows to one kind; either one lets
/// `q` be empty (browse every message with a matching file, newest first).
/// Attachment filenames are always part of the match, and every message hit
/// carries its `attachments` array.
async fn search(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    // Instance admins search everything; everyone else only what they can see.
    let scope_user = (!user.instance_admin).then_some(user.username.as_str());
    let query = q.get("q").map(|s| s.trim()).unwrap_or_default();
    let has_files = matches!(q.get("has_files").map(String::as_str), Some("1" | "true"));
    let file_type = q.get("file_type").map(String::as_str).filter(|s| !s.is_empty());
    let attach_filter = has_files || file_type.is_some();
    // A query is required unless the attachment filter alone is doing the work
    // (browse every message that has a file).
    if query.is_empty() && !attach_filter {
        return Err(err(StatusCode::BAD_REQUEST, "Query required"));
    }
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(20)
        .clamp(1, 50);
    let offset: usize = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
    let channel_id = q.get("channel_id").map(String::as_str).filter(|s| !s.is_empty());
    let group_id = q.get("group_id").map(String::as_str).filter(|s| !s.is_empty());
    let author = q.get("author").map(String::as_str).filter(|s| !s.is_empty());
    let newest_first = q.get("sort").map(String::as_str) == Some("new");
    let match_any = q.get("match").map(String::as_str) == Some("any");
    let types = q.get("types").map(String::as_str).unwrap_or("messages,channels,groups");
    let want = |t: &str| types.split(',').any(|x| x.trim() == t);
    let store = &state.hub.store;
    let mut out = json!({"query": query});
    if want("messages") {
        // One extra row decides has_more without a second query.
        let mut rows = store.search_messages_ext(
            query, match_any, channel_id, group_id, author, None, scope_user, newest_first,
            has_files, file_type, limit + 1, offset,
        );
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        out["messages"] = json!({"items": rows, "has_more": has_more, "offset": offset});
    }
    // Channel/group name matches only make sense with a text query, and are
    // irrelevant to an attachment filter — skip them when browsing files.
    // Their `hidden` badge reflects the caller's own sidebar prefs (keep the
    // relevance order — no positional overlay here).
    let personal_hidden = |mut hits: Vec<Value>, kind: &str| -> Vec<Value> {
        let prefs = store.user_prefs(&user.username, kind);
        for h in &mut hits {
            let id = h["id"].as_str().unwrap_or_default();
            h["hidden"] = json!(prefs.get(id).map(|p| p.0).unwrap_or(false));
        }
        hits
    };
    if want("channels") && !query.is_empty() {
        out["channels"] = json!(personal_hidden(store.search_channels(query, scope_user, 20), "channel"));
    }
    if want("groups") && !query.is_empty() {
        out["groups"] = json!(personal_hidden(store.search_groups(query, scope_user, 20), "group"));
    }
    Ok(Json(out))
}

/// POST /api/search/ask {"q", "channel_id"?, "group_id"?} — AI answer mode:
/// distill the question to keywords, retrieve the best-matching messages via
/// the FTS index, and have Claude write a short answer citing them as [1],
/// [2], …. `sources` come back in citation order ([1] = sources[0]). Needs
/// ANTHROPIC_API_KEY in the server env; `/api/me` advertises it as
/// `search_ai` so clients can hide the control.
async fn search_ask(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let scope_user = (!user.instance_admin).then(|| user.username.clone());
    // Externally billed like the voice endpoints, so share their backstop.
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many AI requests — slow down"));
    }
    let Some(key) = crate::ai::api_key() else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "AI answers need ANTHROPIC_API_KEY set on the server",
        ));
    };
    let question = payload["q"].as_str().unwrap_or("").trim().to_string();
    if question.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Question required"));
    }
    let channel_id = payload["channel_id"].as_str().filter(|s| !s.is_empty());
    let group_id = payload["group_id"].as_str().filter(|s| !s.is_empty());
    // Recall-oriented retrieval: any-term match, bm25 ranks denser hits up.
    let retrieval = crate::ai::retrieval_keywords(&question).unwrap_or_else(|| question.clone());
    let sources = state.hub.store.search_messages(
        &retrieval,
        true,
        channel_id,
        group_id,
        None,
        None,
        scope_user.as_deref(),
        false,
        crate::ai::CONTEXT_MESSAGES,
        0,
    );
    if sources.is_empty() {
        return Ok(Json(json!({
            "answer": Value::Null,
            "sources": [],
            "detail": "No matching messages to answer from",
        })));
    }
    let model = crate::ai::model();
    let answer = {
        let (question, sources, model) = (question.clone(), sources.clone(), model.clone());
        tokio::task::spawn_blocking(move || crate::ai::answer(&key, &model, &question, &sources))
            .await
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "answer task failed"))?
            .map_err(|e| err(StatusCode::BAD_GATEWAY, &format!("{e:#}")))?
    };
    Ok(Json(json!({"answer": answer, "model": model, "sources": sources})))
}

async fn post_message(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let text = payload["text"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Message text required"));
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(err(StatusCode::BAD_REQUEST, "Message too long"));
    }
    let thread_id = resolve_thread(&state, &channel_id, payload["thread_id"].as_i64())?;
    let timezone = client_timezone(payload["timezone"].as_str().unwrap_or(""));
    let reply_in_thread = payload["reply_in_thread"].as_bool().unwrap_or(false);
    let message = state.hub.post_user_message_opts(
        &channel_id,
        &text,
        &user.username,
        Some(&user.display_name),
        thread_id,
        vec![],
        false,
        timezone.as_deref(),
        reply_in_thread,
    );
    Ok(Json(message))
}

/// Normalize a client-supplied IANA timezone: opaque to us beyond a sanity
/// length cap (it only ever reaches agents, never the UI).
fn client_timezone(raw: &str) -> Option<String> {
    let tz = raw.trim();
    if tz.is_empty() || tz.chars().count() > 64 {
        return None;
    }
    Some(tz.to_string())
}

async fn post_message_upload(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many uploads — slow down"));
    }
    require_channel_member(&state, &user, &channel_id)?;
    let max_bytes = state.config.snapshot().max_file_mb as usize * 1024 * 1024;
    let mut text = String::new();
    let mut thread_id: Option<i64> = None;
    let mut timezone: Option<String> = None;
    let mut reply_in_thread = false;
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
            "timezone" => timezone = client_timezone(&field.text().await.unwrap_or_default()),
            "reply_in_thread" => {
                reply_in_thread = field.text().await.unwrap_or_default().trim() == "true";
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
    let message = state.hub.post_user_message_opts(
        &channel_id,
        &text,
        &user.username,
        Some(&user.display_name),
        thread_id,
        attachments,
        false,
        timezone.as_deref(),
        reply_in_thread,
    );
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
    let user = require_user(&state, &headers, &q)?;
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many uploads — slow down"));
    }
    require_channel_member(&state, &user, &channel_id)?;
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
    let mut mentions = String::new();
    let mut timezone: Option<String> = None;
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
            "mentions" => mentions = field.text().await.unwrap_or_default(),
            "timezone" => timezone = client_timezone(&field.text().await.unwrap_or_default()),
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
    // The composer's "talk to" selection rides along as a `mentions` field so
    // voice turns address agents the same way typed messages do ("@a, @b, …" —
    // the transcript alone never contains routable @mentions).
    let text = match mention_prefix(&mentions) {
        Some(prefix) => format!("{prefix}, {text}"),
        None => text,
    };
    let message = state.hub.post_user_message_opts(
        &channel_id,
        &text,
        &user.username,
        Some(&user.display_name),
        thread_id,
        vec![],
        live,
        timezone.as_deref(),
        false,
    );
    Ok(Json(message))
}

/// Normalize a client-supplied `mentions` field into a clean "@a, @b" prefix.
/// Only mention tokens survive (anything else in the field is dropped), so a
/// client can't smuggle arbitrary text in front of a transcript.
fn mention_prefix(raw: &str) -> Option<String> {
    let raw: String = raw.chars().take(500).collect();
    let tokens = crate::hub::mention_tokens(&raw);
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.iter().map(|t| format!("@{t}")).collect::<Vec<_>>().join(", "))
}

/// Synthesize a message as speech for client playback (speak-aloud and live
/// voice). MP3 because Safari's `<audio>` can't decode Opus.
async fn message_speech(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let message = require_message_visible(&state, &user, message_id)?;
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
    let user = require_user(&state, &headers, &q)?;
    let meta = state
        .hub
        .store
        .file(&file_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown file"))?;
    require_channel_member(&state, &user, meta["channel_id"].as_str().unwrap_or_default())?;
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
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let last = state
        .hub
        .mark_read(&user.username, &channel_id, payload["last_read_id"].as_i64());
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
    let user = require_user(&state, &headers, &q)?;
    let mut message = require_message_visible(&state, &user, message_id)?;
    if message["thread_id"].is_null() {
        message["reply_count"] = json!(state.hub.store.thread_size(message_id));
    }
    Ok(Json(message))
}

async fn select_message_option(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_message_visible(&state, &user, message_id)?;
    let option_id = payload["option_id"].as_str().unwrap_or("").trim();
    if option_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "option_id required"));
    }
    match state.hub.select_option(message_id, option_id, &user.username) {
        Ok(message) => Ok(Json(message)),
        Err("Message not found") => Err(err(StatusCode::NOT_FOUND, "Unknown message")),
        Err(msg) => Err(err(StatusCode::CONFLICT, msg)),
    }
}

/// Threads inbox: every thread the user participates in, newest first.
async fn list_threads(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(100)
        .clamp(1, 500);
    Ok(Json(json!({"threads": state.hub.store.my_threads(&user.username, limit)})))
}

/// Give a thread a display alias (or clear it with an empty string) so the
/// inbox/sidebar show a chosen name instead of the root message's first line.
/// Any member who can see the channel may rename it; the change is broadcast
/// so other viewers update live.
async fn update_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let root = state
        .hub
        .store
        .message(thread_id)
        .filter(|m| m["thread_id"].is_null())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    require_channel_member(&state, &user, root["channel_id"].as_str().unwrap_or_default())?;
    // Empty/whitespace clears the alias back to the first message; cap the
    // length at the 140 chars the UIs already truncate snippets to.
    let alias: Option<String> = payload
        .get("alias")
        .and_then(Value::as_str)
        .map(|a| a.trim().chars().take(140).collect::<String>())
        .filter(|a| !a.is_empty());
    let updated = state
        .hub
        .store
        .rename_thread(thread_id, alias.as_deref())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    let channel_id = root["channel_id"].as_str().unwrap_or_default().to_string();
    state.hub.post_transient(
        &channel_id,
        json!({
            "type": "thread_renamed",
            "thread_id": thread_id,
            "channel_id": channel_id,
            "alias": updated["alias"].clone(),
        }),
    );
    Ok(Json(updated))
}

async fn mark_thread_read(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let root = state
        .hub
        .store
        .message(thread_id)
        .filter(|m| m["thread_id"].is_null())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    require_channel_member(&state, &user, root["channel_id"].as_str().unwrap_or_default())?;
    let last = state
        .hub
        .mark_thread_read(&user.username, thread_id, payload["last_read_id"].as_i64());
    Ok(Json(json!({"ok": true, "last_read_id": last})))
}

/// Dismiss a thread from the caller's inbox/sidebar. The messages stay in
/// the channel — this only stops the row from coming back in /api/threads.
async fn hide_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let root = state
        .hub
        .store
        .message(thread_id)
        .filter(|m| m["thread_id"].is_null())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    require_channel_member(&state, &user, root["channel_id"].as_str().unwrap_or_default())?;
    state.hub.store.hide_thread(&user.username, thread_id);
    Ok(Json(json!({"ok": true})))
}

async fn unhide_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    Ok(Json(json!({"ok": state.hub.store.unhide_thread(&user.username, thread_id)})))
}

async fn list_stars(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(json!({"stars": state.hub.store.user_stars(&user.username, &channel_id)})))
}

async fn star_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    let _ = message;
    state.hub.store.star_message(&user.username, &channel_id, message_id);
    Ok(Json(json!({"ok": true})))
}

async fn unstar_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(json!({"ok": state.hub.store.unstar_message(&user.username, message_id)})))
}

async fn list_pins(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(json!({"pins": state.hub.store.channel_pins(&channel_id)})))
}

async fn pin_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
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
    if state.hub.store.pin_message(&channel_id, message_id, Some(&user.username)) {
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
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    if state.hub.store.unpin_message(&channel_id, message_id) {
        state.hub.post_transient(
            &channel_id,
            json!({"type": "pin", "channel_id": channel_id, "pinned": false, "message_id": message_id}),
        );
    }
    Ok(Json(json!({"ok": true})))
}

/* ---------- emoji reactions ---------- */

/// Reactions come from clients as a raw pathname segment; requiring every
/// char to be non-ASCII rules out markup/script metacharacters wholesale
/// (real emoji — including ZWJ sequences and variation selectors — never
/// contain ASCII) while staying agnostic to the clients' curated sets.
fn valid_reaction_emoji(emoji: &str) -> bool {
    !emoji.is_empty() && emoji.len() <= 32 && emoji.chars().all(|c| !c.is_ascii())
}

/// Reloads the message (reactions freshly aggregated), broadcasts it as a
/// `message_update` when something changed — both clients already merge that
/// event — and returns it so the caller can update its cache immediately.
fn reaction_result(
    state: &AppState,
    channel_id: &str,
    message_id: i64,
    changed: bool,
) -> Result<Json<Value>, ApiError> {
    let message = state
        .hub
        .store
        .message(message_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if changed {
        state.hub.post_transient(
            channel_id,
            json!({"type": "message_update", "message": message}),
        );
    }
    Ok(Json(message))
}

async fn add_reaction(
    State(state): State<AppState>,
    Path((channel_id, message_id, emoji)): Path<(String, i64, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if !valid_reaction_emoji(&emoji) {
        return Err(err(StatusCode::BAD_REQUEST, "Not a valid reaction emoji"));
    }
    let groups = message["reactions"].as_array().cloned().unwrap_or_default();
    let already = groups.iter().any(|r| r["emoji"] == emoji.as_str());
    if !already && groups.len() >= MAX_REACTION_KINDS_PER_MESSAGE {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Reaction limit reached for this message",
        ));
    }
    let changed = state
        .hub
        .store
        .add_reaction(&user.username, &channel_id, message_id, &emoji);
    reaction_result(&state, &channel_id, message_id, changed)
}

async fn remove_reaction(
    State(state): State<AppState>,
    Path((channel_id, message_id, emoji)): Path<(String, i64, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    let changed = state
        .hub
        .store
        .remove_reaction(&user.username, message_id, &emoji);
    reaction_result(&state, &channel_id, message_id, changed)
}

async fn channel_agents(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(json!({"agents": state.hub.channel_agents(&channel_id)})))
}

async fn channel_activity(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(state.hub.channel_activity(&channel_id)))
}

async fn available_agents(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_user(&state, &headers, &q)?;
    let live = state.hub.live_agent_ids();
    let agents: Vec<Value> = state
        .hub
        .store
        .known_agents()
        .into_iter()
        .map(|mut a| {
            let id = a["id"].as_str().unwrap_or_default().to_string();
            a["live"] = json!(live.contains(&id));
            a["avatar"] = agent_avatar_path(&a);
            a
        })
        .collect();
    Ok(Json(json!({"agents": agents})))
}

/// The same-origin proxy path for an agent's picture (the browser can't reach
/// the agent's home instance directly), or null when it has none. ?v= busts
/// caches when the picture changes upstream.
fn agent_avatar_path(agent: &Value) -> Value {
    if !agent["has_avatar"].as_bool().unwrap_or(false) {
        return Value::Null;
    }
    json!(format!(
        "/api/agents/{}/avatar?v={}",
        agent["id"].as_str().unwrap_or_default(),
        agent["avatar_v"].as_i64().unwrap_or(0)
    ))
}

/// Ceiling on proxied avatar bytes (Pantheo caps uploads at 2 MB).
const MAX_AVATAR_BYTES: u64 = 4 * 1024 * 1024;

/// Derive a Pantheo instance's HTTP(S) base from its dial-out websocket URL:
/// `wss://host[:port][/prefix]/agora/connect` → `https://host[:port][/prefix]`.
fn pantheo_http_base(ws_url: &str) -> Option<String> {
    let trimmed = ws_url.trim().trim_end_matches('/');
    let base = trimmed.strip_suffix("/agora/connect")?;
    if let Some(rest) = base.strip_prefix("wss://") {
        Some(format!("https://{rest}"))
    } else if let Some(rest) = base.strip_prefix("ws://") {
        Some(format!("http://{rest}"))
    } else if base.starts_with("https://") || base.starts_with("http://") {
        Some(base.to_string())
    } else {
        None
    }
}

/// Blocking GET of the avatar bytes from the agent's home instance
/// (call via `spawn_blocking`).
fn fetch_avatar(url: &str, token: &str) -> anyhow::Result<(String, Vec<u8>)> {
    use std::io::Read;

    let response = ureq::get(url)
        .timeout(Duration::from_secs(10))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| anyhow::anyhow!("avatar fetch failed: {e}"))?;
    let mime = response.content_type().to_string();
    let mut data = Vec::new();
    response.into_reader().take(MAX_AVATAR_BYTES).read_to_end(&mut data)?;
    anyhow::ensure!(!data.is_empty(), "empty avatar response");
    Ok((mime, data))
}

/// Proxy an agent's profile picture from its home instance. The browser can't
/// fetch it directly — the instance may be private and the connection token
/// must never reach the client — but the connection that carried the agent
/// knows both the origin and the token. Misses return 404 so the UI's onerror
/// handler falls back to the robot emoji.
async fn agent_avatar(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_user(&state, &headers, &q)?;
    let agent = state
        .hub
        .store
        .agent(&agent_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown agent"))?;
    if !agent["has_avatar"].as_bool().unwrap_or(false) {
        return Err(err(StatusCode::NOT_FOUND, "No profile picture"));
    }
    let source = agent["source"].as_str().unwrap_or_default().to_string();
    let conn = state
        .config
        .snapshot()
        .connections
        .into_iter()
        .find(|c| c.name == source)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Agent's connection is not configured"))?;
    let base = pantheo_http_base(&conn.url)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "No HTTP address for the agent's instance"))?;
    let url = format!("{base}/admin/api/agents/{agent_id}/avatar");
    let (mime, data) = tokio::task::spawn_blocking(move || fetch_avatar(&url, &conn.token))
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "Avatar fetch failed"))?
        .map_err(|e| {
            tracing::debug!("avatar proxy for {agent_id}: {e}");
            err(StatusCode::NOT_FOUND, "No profile picture")
        })?;
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        "content-type",
        mime.parse()
            .unwrap_or_else(|_| "application/octet-stream".parse().unwrap()),
    );
    // The URL carries a version stamp (?v=), so long client caching is safe.
    resp_headers.insert("cache-control", "private, max-age=86400".parse().unwrap());
    Ok((resp_headers, data).into_response())
}

async fn forget_agent(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
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
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
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
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
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
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
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
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
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
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
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
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
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
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    state.config.update(|c| c.connections.retain(|x| x.name != name));
    state.connections.sync();
    Ok(Json(json!({"ok": true})))
}

async fn list_pairing(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    Ok(Json(json!({"tokens": state.config.snapshot().pairing_tokens})))
}

async fn create_pairing(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
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
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    state.config.update(|c| c.pairing_tokens.retain(|t| t.token != token));
    Ok(Json(json!({"ok": true})))
}

// ----------------------------------------------------------- push tokens

/// Expo push tokens look like `ExponentPushToken[...]` (legacy: `ExpoPushToken[...]`).
fn valid_expo_push_token(token: &str) -> bool {
    let t = token.trim();
    (t.starts_with("ExponentPushToken[") || t.starts_with("ExpoPushToken[")) && t.ends_with(']')
}

async fn register_push_token(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let token = payload["token"].as_str().unwrap_or("").trim().to_string();
    if !valid_expo_push_token(&token) {
        return Err(err(StatusCode::BAD_REQUEST, "Invalid Expo push token"));
    }
    let platform = payload["platform"].as_str().unwrap_or("").trim().to_string();
    state.hub.store.upsert_push_token(&user.username, &token, &platform);
    Ok(Json(json!({"ok": true})))
}

async fn unregister_push_token(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_user(&state, &headers, &q)?;
    let token = payload["token"].as_str().unwrap_or("").trim().to_string();
    if token.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "token required"));
    }
    state.hub.store.delete_push_token(&token);
    Ok(Json(json!({"ok": true})))
}

// --------------------------------------------------------------- sign-in

/// Resolve a provider-verified email to a workspace account and mint its
/// session. Existing user → sign in (unless disabled). No user but a pending
/// invite, a valid invite-link token, or a spot on the config allowlists
/// (the pre-account gate) → the account is created on first sign-in.
/// Anything else is rejected — possession of a Google/Apple account grants
/// nothing by itself.
fn signin_session_for_email(
    state: &AppState,
    email: &str,
    link_token: Option<&str>,
) -> Result<String, &'static str> {
    let store = &state.hub.store;
    if let Some(user) = store.user_by_email(email) {
        if user["disabled"].as_bool().unwrap_or(false) {
            return Err("disabled");
        }
        let username = user["username"].as_str().unwrap_or_default();
        let version = user["session_version"].as_i64().unwrap_or(1);
        return Ok(crate::auth::mint_session(username, version, &state.config.session_secret()));
    }
    let invite = store.pending_invite(email);
    let link = link_token.and_then(|t| store.valid_invite_link(t));
    let allowlisted = {
        let snap = state.config.snapshot();
        let email = email.trim().to_lowercase();
        snap.google_allowed_emails
            .iter()
            .chain(snap.apple_allowed_emails.iter())
            .any(|e| e.trim().to_lowercase() == email)
    };
    if invite.is_none() && link.is_none() && !allowlisted {
        return Err("no_access");
    }
    let base = email.split('@').next().unwrap_or("user");
    let username = store.unique_username(base);
    // An email invite's role wins over a link's (it names this person).
    let role = invite
        .as_ref()
        .or(link.as_ref())
        .and_then(|i| i["instance_role"].as_str().map(str::to_string))
        .unwrap_or_else(|| "member".to_string());
    if invite.is_none() && !allowlisted {
        // Admission rests on the link alone: consume it *before* creating
        // the account. The UPDATE's guard is atomic, so a raced second
        // sign-in on the same link loses and is rejected here.
        if !store.use_invite_link(link_token.unwrap_or(""), &username) {
            return Err("no_access");
        }
    }
    let user = store
        .create_user(&username, base, Some(email), &role)
        .ok_or("no_access")?;
    if invite.is_some() {
        store.accept_invite(email);
    }
    tracing::info!("{email} joined as {username} ({role})");
    let version = user["session_version"].as_i64().unwrap_or(1);
    Ok(crate::auth::mint_session(&username, version, &state.config.session_secret()))
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
        "apple": {"enabled": state.config.apple().is_some()},
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
    // An invite-link token rides through the OAuth round-trip in the state;
    // it is validated at redeem time, after the email is verified.
    let invite = q.get("invite").map(String::as_str).unwrap_or("");
    let oauth_state = crate::auth::encode_state(&next, invite);
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
    let invite = crate::auth::invite_from_state(&state_param);
    let session = match signin_session_for_email(&state, &email, invite.as_deref()) {
        Ok(session) => session,
        Err(reason) => {
            tracing::warn!("google sign-in: {email} rejected: {reason}");
            return land_err(if reason == "disabled" { "disabled" } else { "no_access" });
        }
    };
    tracing::info!("google sign-in: {email} accepted");
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

// -------------------------------------------------------- sign in with apple

/// Native Sign in with Apple: the iOS app runs Apple's system sheet and posts
/// the resulting identity token here. Verification (JWKS signature, issuer,
/// bundle-id audience, email allowlist) lives in `auth::verify_apple_token`;
/// success mints the same session a Google sign-in would.
async fn apple_signin(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !state.auth_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts — slow down"));
    }
    let Some(ac) = state.config.apple() else {
        return Err(err(StatusCode::NOT_FOUND, "Apple sign-in is not enabled"));
    };
    let identity_token = body["identity_token"].as_str().unwrap_or_default().to_string();
    if identity_token.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "identity_token is required"));
    }
    // Native clients pass an invite-link token alongside the identity token.
    let invite = body["invite_token"].as_str().map(str::to_string);
    let verified = tokio::task::spawn_blocking(move || {
        crate::auth::verify_apple_token(&identity_token, &ac)
    })
    .await;
    match verified {
        Ok(Ok(email)) => match signin_session_for_email(&state, &email, invite.as_deref()) {
            Ok(session) => {
                tracing::info!("apple sign-in: {email} accepted");
                Ok(Json(json!({"token": session})))
            }
            Err(reason) => {
                tracing::warn!("apple sign-in: {email} rejected ({reason})");
                Err(err(
                    StatusCode::UNAUTHORIZED,
                    "That Apple account isn't allowed on this instance",
                ))
            }
        },
        Ok(Err(e)) => {
            tracing::warn!("apple sign-in: identity token rejected: {e}");
            let detail = if e.to_string().contains("allowlist") {
                "That Apple account isn't allowed on this instance"
            } else {
                "Apple sign-in failed"
            };
            Err(err(StatusCode::UNAUTHORIZED, detail))
        }
        Err(_) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, "Apple sign-in failed")),
    }
}

// ------------------------------------------------------------- websockets

async fn ui_ws(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    // Browsers can't set headers on a websocket, so auth rides on ?token=.
    let token = q.get("token").cloned().unwrap_or_default();
    let Some(user) = authed_user(&state, &token) else {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    };
    ws.on_upgrade(move |socket| handle_ui_socket(state, user, socket))
}

async fn handle_ui_socket(state: AppState, user: AuthedUser, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = unbounded_channel::<Value>();
    // Real identity, privileged only for the operator: the hub's per-channel
    // visibility filtering applies to everyone else.
    let socket_id = state
        .hub
        .attach_socket(&user.username, user.instance_admin, tx);
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
                                    // Dial-in bridges have no HTTP origin to proxy
                                    // an avatar from; they stay on the emoji.
                                    has_avatar: false,
                                    avatar_v: 0,
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

    fn test_state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let config = Arc::new(Config::load(dir.path()).unwrap());
        let hub = Arc::new(Hub::new(Arc::new(crate::store::Store::open_in_memory().unwrap())));
        let connections = ConnectionManager::new(Arc::clone(&hub), Arc::clone(&config));
        let (auth_limiter, upload_limiter) = AppState::default_limiters();
        let state = AppState {
            hub,
            config,
            connections,
            ui_dir: None,
            data_dir: dir.path().to_path_buf(),
            restart_handler: Arc::new(std::sync::Mutex::new(None)),
            speech_cache: Arc::new(std::sync::Mutex::new(Vec::new())),
            auth_limiter,
            upload_limiter,
        };
        (state, dir)
    }

    #[test]
    fn authed_user_resolves_admin_key_and_user_sessions() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;

        // The admin key is the operator: instance admin, config username.
        let admin = authed_user(&state, &state.config.admin_key()).unwrap();
        assert!(admin.instance_admin);
        assert_eq!(admin.username, state.config.username());
        assert!(authed_user(&state, "garbage").is_none());

        // A member session resolves to that user, without admin powers.
        let user = store.create_user("ana", "Ana", Some("ana@x.io"), "member").unwrap();
        let v = user["session_version"].as_i64().unwrap();
        let token = crate::auth::mint_session("ana", v, &state.config.session_secret());
        let ana = authed_user(&state, &token).unwrap();
        assert_eq!(ana.username, "ana");
        assert_eq!(ana.display_name, "Ana");
        assert!(!ana.instance_admin);

        // An instance_role=admin user is an instance admin.
        let boss = store.create_user("boss", "", Some("boss@x.io"), "admin").unwrap();
        let bt = crate::auth::mint_session(
            "boss",
            boss["session_version"].as_i64().unwrap(),
            &state.config.session_secret(),
        );
        assert!(authed_user(&state, &bt).unwrap().instance_admin);

        // Bumping the session version revokes outstanding tokens…
        store.bump_session_version("ana");
        assert!(authed_user(&state, &token).is_none());
        // …and disabling the account blocks even a fresh one.
        let v2 = store.user("ana").unwrap()["session_version"].as_i64().unwrap();
        let fresh = crate::auth::mint_session("ana", v2, &state.config.session_secret());
        assert!(authed_user(&state, &fresh).is_some());
        store.set_user_disabled("ana", true);
        assert!(authed_user(&state, &fresh).is_none());
    }

    #[test]
    fn signin_maps_emails_to_accounts_invites_and_allowlist() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;

        // Unknown email: rejected outright.
        assert_eq!(signin_session_for_email(&state, "rando@x.io", None), Err("no_access"));

        // Existing account: signs in as that user.
        store.create_user("ana", "Ana", Some("ana@x.io"), "member").unwrap();
        let token = signin_session_for_email(&state, "ana@x.io", None).unwrap();
        assert_eq!(authed_user(&state, &token).unwrap().username, "ana");

        // Disabled account: rejected.
        store.set_user_disabled("ana", true);
        assert_eq!(signin_session_for_email(&state, "ana@x.io", None), Err("disabled"));

        // Pending invite: first sign-in creates the account with the invited
        // role and consumes the invite.
        store.create_invite("bob@x.io", Some("ana"), "admin").unwrap();
        let token = signin_session_for_email(&state, "bob@x.io", None).unwrap();
        let bob = authed_user(&state, &token).unwrap();
        assert_eq!(bob.username, "bob");
        assert!(bob.instance_admin);
        assert!(store.pending_invite("bob@x.io").is_none());
        // Signing in again reuses the account rather than minting another.
        let again = signin_session_for_email(&state, "bob@x.io", None).unwrap();
        assert_eq!(authed_user(&state, &again).unwrap().username, "bob");

        // Config allowlist (the pre-account gate) still admits, as a member.
        state.config.update(|c| c.google_allowed_emails = vec!["carol@x.io".into()]);
        let token = signin_session_for_email(&state, "carol@x.io", None).unwrap();
        let carol = authed_user(&state, &token).unwrap();
        assert_eq!(carol.username, "carol");
        assert!(!carol.instance_admin);
    }

    #[test]
    fn authz_helpers_enforce_the_role_matrix() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("ana", "", None, "member").unwrap();
        store.create_user("mal", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("ana"));
        let gid = g["id"].as_str().unwrap();
        // create_group's auto-admin membership is added by the handler; do it
        // here the same way.
        store.add_member(gid, "user", "ana", "admin", None);
        let c = store.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap();

        let ana = AuthedUser {
            username: "ana".into(),
            display_name: "ana".into(),
            instance_admin: false,
        };
        let mal = AuthedUser {
            username: "mal".into(),
            display_name: "mal".into(),
            instance_admin: false,
        };
        let op = AuthedUser {
            username: "op".into(),
            display_name: "op".into(),
            instance_admin: true,
        };

        // Group admin (creator) passes everything for the group.
        assert!(require_member(&state, &ana, gid).is_ok());
        assert!(require_group_admin(&state, &ana, gid).is_ok());
        assert!(require_channel_member(&state, &ana, cid).is_ok());
        // Non-member: 403 across the board.
        assert!(require_member(&state, &mal, gid).is_err());
        assert!(require_group_admin(&state, &mal, gid).is_err());
        assert!(require_channel_member(&state, &mal, cid).is_err());
        assert!(require_instance_admin(&mal).is_err());
        // Plain member: sees, but doesn't administer.
        store.add_member(gid, "user", "mal", "member", None);
        assert!(require_member(&state, &mal, gid).is_ok());
        assert!(require_group_admin(&state, &mal, gid).is_err());
        // The operator bypasses membership entirely.
        assert!(require_member(&state, &op, gid).is_ok());
        assert!(require_group_admin(&state, &op, gid).is_ok());
        assert!(require_instance_admin(&op).is_ok());

        // Message visibility follows the channel's group.
        let m = state.hub.post_user_message(cid, "hello", "ana", None, None, vec![]);
        let mid = m["id"].as_i64().unwrap();
        assert!(require_message_visible(&state, &mal, mid).is_ok());
        store.remove_member(gid, "user", "mal", None);
        assert!(require_message_visible(&state, &mal, mid).is_err());
    }

    #[test]
    fn expo_push_token_shape() {
        assert!(valid_expo_push_token("ExponentPushToken[xxxxxx]"));
        assert!(valid_expo_push_token("ExpoPushToken[legacy]"));
        assert!(!valid_expo_push_token(""));
        assert!(!valid_expo_push_token("not-a-token"));
        assert!(!valid_expo_push_token("ExponentPushToken[no-close"));
    }

    #[test]
    fn mention_prefix_normalizes_and_rejects_smuggled_text() {
        assert_eq!(mention_prefix("@claude"), Some("@claude".into()));
        assert_eq!(mention_prefix("@a, @b"), Some("@a, @b".into()));
        // Slugs keep word chars / dots / dashes; case folds like typed mentions.
        assert_eq!(mention_prefix("@Kite-Bot"), Some("@kite-bot".into()));
        // Non-mention text is dropped, not prepended.
        assert_eq!(mention_prefix("ignore this @claude do that"), Some("@claude".into()));
        assert_eq!(mention_prefix("no mentions here"), None);
        assert_eq!(mention_prefix(""), None);
    }

    #[test]
    fn agent_avatar_path_maps_flag_to_proxy_url() {
        let with = json!({"id": "mimir", "has_avatar": true, "avatar_v": 1234});
        assert_eq!(agent_avatar_path(&with), json!("/api/agents/mimir/avatar?v=1234"));
        let without = json!({"id": "mimir", "has_avatar": false, "avatar_v": 0});
        assert_eq!(agent_avatar_path(&without), Value::Null);
        // Third-party bots that never sent the field stay on the emoji.
        let legacy = json!({"id": "claw-1"});
        assert_eq!(agent_avatar_path(&legacy), Value::Null);
    }

    #[test]
    fn pantheo_http_base_derives_from_connect_url() {
        assert_eq!(
            pantheo_http_base("wss://x.example:8765/agora/connect"),
            Some("https://x.example:8765".into())
        );
        assert_eq!(
            pantheo_http_base("ws://localhost:8765/agora/connect/"),
            Some("http://localhost:8765".into())
        );
        assert_eq!(
            pantheo_http_base("wss://host/prefix/agora/connect"),
            Some("https://host/prefix".into())
        );
        // Not a connect URL, or not a websocket/http scheme.
        assert_eq!(pantheo_http_base("wss://host/other"), None);
        assert_eq!(pantheo_http_base("ftp://host/agora/connect"), None);
    }

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

    /// Auth headers for a freshly minted session of `username`.
    fn session_headers(state: &AppState, username: &str) -> HeaderMap {
        let v = state.hub.store.user(username).unwrap()["session_version"]
            .as_i64()
            .unwrap();
        let token = crate::auth::mint_session(username, v, &state.config.session_secret());
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {token}").parse().unwrap());
        h
    }

    #[tokio::test]
    async fn reactions_toggle_validate_and_gate_membership() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("ana", "", None, "member").unwrap();
        store.create_user("mal", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("ana"));
        let gid = g["id"].as_str().unwrap();
        store.add_member(gid, "user", "ana", "admin", None);
        let c = store.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        let m = store.add_message(&cid, "hello", "user", "ana", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();
        let ana = session_headers(&state, "ana");
        let q = || Query(HashMap::new());

        // PUT adds and returns the updated message payload.
        let res = add_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "👍".to_string())),
            q(),
            ana.clone(),
        )
        .await
        .unwrap();
        assert_eq!(res.0["reactions"], json!([{"emoji": "👍", "users": ["ana"]}]));

        // Duplicate PUT is a no-op but still succeeds with the same payload.
        let res = add_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "👍".to_string())),
            q(),
            ana.clone(),
        )
        .await
        .unwrap();
        assert_eq!(res.0["reactions"][0]["users"], json!(["ana"]));

        // ASCII (markup-capable) "emoji" are rejected.
        let bad = add_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "<img>".to_string())),
            q(),
            ana.clone(),
        )
        .await;
        assert!(bad.is_err());

        // Non-members can't react.
        let mal = session_headers(&state, "mal");
        let denied = add_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "👍".to_string())),
            q(),
            mal,
        )
        .await;
        assert!(denied.is_err());

        // DELETE removes and the payload reflects it.
        let res = remove_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "👍".to_string())),
            q(),
            ana,
        )
        .await
        .unwrap();
        assert_eq!(res.0["reactions"], json!([]));
    }

    #[tokio::test]
    async fn hide_and_reorder_are_per_user_rename_stays_admin() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("boss", "", None, "member").unwrap();
        store.create_user("ana", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("boss"));
        let gid = g["id"].as_str().unwrap().to_string();
        store.add_member(&gid, "user", "ana", "member", None);
        let c = store.create_channel(&gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        let boss = session_headers(&state, "boss");
        let ana = session_headers(&state, "ana");
        let q = || Query(HashMap::new());

        // A plain member hides the group — for themselves only.
        let res = update_group(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            ana.clone(),
            Json(json!({"hidden": true})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["hidden"], true);
        let mine = list_groups(State(state.clone()), q(), ana.clone()).await.unwrap();
        assert_eq!(mine.0["groups"][0]["hidden"], true);
        let theirs = list_groups(State(state.clone()), q(), boss.clone()).await.unwrap();
        assert_eq!(theirs.0["groups"][0]["hidden"], false);

        // Channel hide: same story, and the admin's view keeps it visible.
        let res = update_channel(
            State(state.clone()),
            Path((gid.clone(), cid.clone())),
            q(),
            ana.clone(),
            Json(json!({"hidden": true})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["hidden"], true);
        let theirs = list_groups(State(state.clone()), q(), boss.clone()).await.unwrap();
        assert_eq!(theirs.0["groups"][0]["channels"][0]["hidden"], false);

        // Renaming edits the shared channel: members are refused.
        let refused = update_channel(
            State(state.clone()),
            Path((gid.clone(), cid.clone())),
            q(),
            ana.clone(),
            Json(json!({"name": "hijacked"})),
        )
        .await;
        assert!(refused.is_err());

        // Reordering writes the caller's own positions.
        let c2 = store.create_channel(&gid, "alpha", "");
        let c2id = c2["id"].as_str().unwrap().to_string();
        let _ = reorder_channels(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            ana.clone(),
            Json(json!({"ids": [c2id.clone(), cid.clone()]})),
        )
        .await
        .unwrap();
        let mine = list_groups(State(state.clone()), q(), ana.clone()).await.unwrap();
        assert_eq!(mine.0["groups"][0]["channels"][0]["id"], c2id.as_str());
        // The admin keeps the store's (creation) order.
        let theirs = list_groups(State(state.clone()), q(), boss).await.unwrap();
        assert_eq!(theirs.0["groups"][0]["channels"][0]["id"], cid.as_str());
    }

    #[tokio::test]
    async fn update_me_renames_self_and_cannot_escalate() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("ana", "Ana", None, "member").unwrap();
        let ana = session_headers(&state, "ana");
        let q = || Query(HashMap::new());

        let res = update_me(
            State(state.clone()),
            q(),
            ana.clone(),
            // Smuggled admin fields must be ignored — only display_name is
            // self-service.
            Json(json!({"display_name": "  Ana Banana  ", "instance_role": "admin", "disabled": false})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["display_name"], "Ana Banana");
        let row = store.user("ana").unwrap();
        assert_eq!(row["display_name"], "Ana Banana");
        assert_eq!(row["instance_role"], "member");

        // Blank clears back to the username.
        let res = update_me(State(state.clone()), q(), ana, Json(json!({"display_name": ""})))
            .await
            .unwrap();
        assert_eq!(res.0["display_name"], "ana");
        assert_eq!(store.user("ana").unwrap()["display_name"], "");
    }

    #[test]
    fn signin_accepts_a_valid_link_token_once() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;

        let link = store.create_invite_link(Some("boss"), "member", 3600.0);
        let token = link["token"].as_str().unwrap().to_string();

        // Without the token the email is a stranger.
        assert_eq!(signin_session_for_email(&state, "dave@x.io", None), Err("no_access"));
        // With it, the account is created with the link's role and the link
        // is consumed.
        let session = signin_session_for_email(&state, "dave@x.io", Some(&token)).unwrap();
        let dave = authed_user(&state, &session).unwrap();
        assert_eq!(dave.username, "dave");
        assert!(!dave.instance_admin);
        assert_eq!(store.invite_link(&token).unwrap()["used_by"], "dave");

        // Single-use: the next stranger is turned away…
        assert_eq!(
            signin_session_for_email(&state, "eve@x.io", Some(&token)),
            Err("no_access")
        );
        // …but the admitted user keeps signing in without it.
        assert!(signin_session_for_email(&state, "dave@x.io", None).is_ok());

        // Expired links admit nobody.
        let stale = store.create_invite_link(None, "member", -1.0);
        let stale_token = stale["token"].as_str().unwrap();
        assert_eq!(
            signin_session_for_email(&state, "late@x.io", Some(stale_token)),
            Err("no_access")
        );
    }
}
