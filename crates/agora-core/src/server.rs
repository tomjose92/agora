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
use std::sync::Arc;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
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

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<Hub>,
    pub config: Arc<Config>,
    pub connections: Arc<ConnectionManager>,
    pub ui_dir: Option<std::path::PathBuf>,
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

fn require_owner(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> Result<String, ApiError> {
    let token = bearer(headers)
        .or_else(|| query.get("token").cloned())
        .unwrap_or_default();
    if state.config.is_owner_token(&token) {
        Ok(state.config.username())
    } else {
        Err(err(StatusCode::UNAUTHORIZED, "Authentication required"))
    }
}

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .route("/api/me", get(me))
        .route("/api/groups", get(list_groups).post(create_group))
        .route("/api/groups/{group_id}", delete(delete_group))
        .route("/api/groups/{group_id}/channels", post(create_channel))
        .route("/api/groups/{group_id}/channels/{channel_id}", delete(delete_channel))
        .route("/api/groups/{group_id}/members", get(list_members).post(add_member))
        .route(
            "/api/groups/{group_id}/members/{member_type}/{member_id}",
            delete(remove_member),
        )
        .route(
            "/api/channels/{channel_id}/messages",
            get(list_messages).post(post_message),
        )
        .route("/api/channels/{channel_id}/messages/upload", post(post_message_upload))
        .route("/api/channels/{channel_id}/read", put(mark_read))
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
        .route("/api/pairing", get(list_pairing).post(create_pairing))
        .route("/api/pairing/{token}", delete(revoke_pairing))
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
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_owner(&state, &headers, &q)?;
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
                let mime = field.content_type().unwrap_or("").split(';').next().unwrap_or("").to_string();
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
                    mime,
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

// ------------------------------------------------------------- websockets

async fn ui_ws(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    // Browsers can't set headers on a websocket, so auth rides on ?token=.
    let token = q.get("token").cloned().unwrap_or_default();
    if !state.config.is_owner_token(&token) {
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
