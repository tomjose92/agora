//! SQLite persistence for Agora: groups, channels, memberships, messages,
//! pins, stars, read markers, attachments, and the remembered-agents registry.
//!
//! Faithful port of Pantheo's `engine/agora/store.py` — payload shapes are
//! kept JSON-identical so the ported web UI works unchanged. Channel ids
//! double as chat ids in agent session keys, so they get a readable
//! `slug-hex` shape (`fitness-3f2a`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at REAL NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_id);
CREATE TABLE IF NOT EXISTS memberships (
    group_id TEXT NOT NULL,
    channel_id TEXT NOT NULL DEFAULT '',
    member_type TEXT NOT NULL,
    member_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    added_at REAL NOT NULL,
    PRIMARY KEY (group_id, channel_id, member_type, member_id)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    thread_id INTEGER,
    author_type TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT,
    text TEXT NOT NULL,
    ts REAL NOT NULL,
    meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE TABLE IF NOT EXISTS pins (
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    pinned_by TEXT,
    pinned_at REAL NOT NULL,
    PRIMARY KEY (channel_id, message_id)
);
CREATE TABLE IF NOT EXISTS stars (
    username TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    starred_at REAL NOT NULL,
    PRIMARY KEY (username, message_id)
);
CREATE INDEX IF NOT EXISTS idx_stars_user_channel ON stars(username, channel_id);
CREATE TABLE IF NOT EXISTS reads (
    username TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL,
    PRIMARY KEY (username, channel_id)
);
-- Per-thread read markers (threads have their own unread state; channel
-- badges only count top-level messages).
CREATE TABLE IF NOT EXISTS thread_reads (
    username TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL,
    PRIMARY KEY (username, thread_id)
);
-- Threads dismissed from the user's inbox/sidebar. The messages stay in the
-- channel; the thread just stops surfacing in `my_threads`.
CREATE TABLE IF NOT EXISTS thread_hides (
    username TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    hidden_at REAL NOT NULL,
    PRIMARY KEY (username, thread_id)
);
-- One row per user @mentioned by a message; drives mention-aware badges.
CREATE TABLE IF NOT EXISTS mentions (
    message_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    username TEXT NOT NULL,
    PRIMARY KEY (message_id, username)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user_channel ON mentions(username, channel_id, message_id);
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL,
    ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_id);
CREATE INDEX IF NOT EXISTS idx_files_channel ON files(channel_id);
-- Agents the app has seen from any connection (dial-out hello or dial-in
-- pairing). Memberships reference these ids; persisting them means the
-- member picker and channel rosters survive restarts while agents are
-- offline. `source` is the connection name the agent last appeared on.
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    requires_mention INTEGER NOT NULL DEFAULT 0,
    last_seen REAL NOT NULL,
    -- Whether the agent's home instance offers a profile picture, plus a
    -- cache-busting stamp (file mtime there); the bytes are proxied on demand.
    has_avatar INTEGER NOT NULL DEFAULT 0,
    avatar_v INTEGER NOT NULL DEFAULT 0
);
-- Full-text index over message text (external content: rows live in
-- `messages`, the index holds only tokens). Porter stemming so "deploy"
-- finds "deployed"/"deployment". Kept in sync by the triggers below;
-- migrate() rebuilds it when it drifts (e.g. a database that predates it).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='id',
    tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
"#;

/// Columns added after v1 shipped: CREATE TABLE IF NOT EXISTS won't alter
/// existing tables, so bolt them on when missing.
fn migrate(conn: &Connection) {
    let has_column = |table: &str, column: &str| -> bool {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
        let found = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .any(|c| c == column);
        found
    };
    for table in ["groups", "channels"] {
        if !has_column(table, "position") {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN position INTEGER NOT NULL DEFAULT 0"),
                [],
            )
            .unwrap();
        }
        // Hidden = tucked away in the sidebar, not deleted.
        if !has_column(table, "hidden") {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"),
                [],
            )
            .unwrap();
        }
    }
    for column in ["has_avatar", "avatar_v"] {
        if !has_column("agents", column) {
            conn.execute(
                &format!("ALTER TABLE agents ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"),
                [],
            )
            .unwrap();
        }
    }
    if !has_column("messages", "meta") {
        conn.execute("ALTER TABLE messages ADD COLUMN meta TEXT", []).unwrap();
    }
    // A user-chosen display name for a thread; only meaningful on root rows
    // (thread_id IS NULL). NULL = fall back to the root message's first line.
    if !has_column("messages", "thread_alias") {
        conn.execute("ALTER TABLE messages ADD COLUMN thread_alias TEXT", []).unwrap();
    }
    // Databases that predate the FTS index get it created empty by SCHEMA —
    // the triggers only cover writes from then on, so the existing history
    // needs a one-time backfill. Row counts can't detect this (a bare scan of
    // an external-content FTS table reads through to `messages`, so the
    // counts always agree even when the index is empty); use the schema
    // version marker instead.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if version < 1 {
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')", [])
            .unwrap();
        conn.execute("PRAGMA user_version = 1", []).unwrap();
    }
}

pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

pub fn slugify(name: &str) -> String {
    let lowered = name.to_lowercase();
    let mapped: String = lowered
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    mapped
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn new_id(name: &str) -> String {
    let slug: String = slugify(name).chars().take(32).collect();
    let n: u16 = rand::random();
    format!("{}-{:04x}", slug, n)
}

pub fn new_token() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Build a safe FTS5 MATCH expression from raw user input. Double-quoted runs
/// stay exact phrases; bare words become quoted terms with the last one a
/// prefix (`"agor"*`) so search-as-you-type works. Quoting every term means
/// user input can never be parsed as FTS5 syntax (`AND`, `-`, `:` …), so an
/// arbitrary query string can't error the index.
pub fn fts_query(raw: &str) -> Option<String> {
    let mut terms: Vec<(String, bool)> = Vec::new(); // (term, is_phrase)
    let mut cur = String::new();
    let mut in_phrase = false;
    let flush = |cur: &mut String, terms: &mut Vec<(String, bool)>, phrase: bool| {
        let t: String = cur.chars().filter(|c| *c != '"').collect();
        if !t.trim().is_empty() {
            terms.push((t.trim().to_string(), phrase));
        }
        cur.clear();
    };
    for ch in raw.chars() {
        match ch {
            '"' => {
                flush(&mut cur, &mut terms, in_phrase);
                in_phrase = !in_phrase;
            }
            c if c.is_whitespace() && !in_phrase => flush(&mut cur, &mut terms, false),
            c => cur.push(c),
        }
    }
    flush(&mut cur, &mut terms, in_phrase);
    if terms.is_empty() {
        return None;
    }
    let last = terms.len() - 1;
    Some(
        terms
            .iter()
            .enumerate()
            .map(|(i, (t, phrase))| {
                if !phrase && i == last {
                    format!("\"{t}\"*")
                } else {
                    format!("\"{t}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// OR-of-terms MATCH expression for recall-oriented retrieval (AI answers):
/// every word matches independently, bm25 ranks messages hitting more of
/// them higher. Same quoting rule as [`fts_query`], so input is never syntax.
pub fn fts_query_any(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        .map(|w| w.chars().filter(|c| *c != '"').collect::<String>())
        .filter(|w| !w.trim().is_empty())
        .map(|w| format!("\"{}\"", w.trim()))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

/// `%…%` LIKE pattern with the wildcards in the user's input neutralized.
fn like_pattern(raw: &str) -> String {
    let escaped: String = raw
        .chars()
        .flat_map(|c| match c {
            '\\' | '%' | '_' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    format!("%{escaped}%")
}

fn message_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Value> {
    let meta_raw: Option<String> = row.get(offset + 8)?;
    let meta = meta_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or(Value::Null);
    Ok(json!({
        "id": row.get::<_, i64>(offset)?,
        "channel_id": row.get::<_, String>(offset + 1)?,
        "thread_id": row.get::<_, Option<i64>>(offset + 2)?,
        "author_type": row.get::<_, String>(offset + 3)?,
        "author_id": row.get::<_, String>(offset + 4)?,
        "author_name": row.get::<_, Option<String>>(offset + 5)?,
        "text": row.get::<_, String>(offset + 6)?,
        "ts": row.get::<_, f64>(offset + 7)?,
        "meta": meta,
    }))
}

const MSG_COLS: &str =
    "id, channel_id, thread_id, author_type, author_id, author_name, text, ts, meta";

/// An uploaded attachment on its way into `add_message`.
pub struct NewAttachment {
    pub filename: String,
    pub mime: String,
    pub data: Vec<u8>,
}

pub struct Store {
    conn: Mutex<Connection>,
    pub files_dir: PathBuf,
}

impl Store {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
            files_dir: path.parent().unwrap_or(Path::new(".")).join("agora_files"),
        })
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
            files_dir: std::env::temp_dir().join("agora_files_test"),
        })
    }

    /// Consistent snapshot of the live database into `dest` (SQLite online
    /// backup — safe while the server keeps writing).
    pub fn backup_to(&self, dest: &Path) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let mut dst = Connection::open(dest)?;
        let backup = rusqlite::backup::Backup::new(&conn, &mut dst)?;
        backup.run_to_completion(256, std::time::Duration::from_millis(2), None)?;
        Ok(())
    }

    /// Row counts for the export manifest.
    pub fn counts(&self) -> Value {
        let conn = self.conn.lock().unwrap();
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap_or(0)
        };
        json!({
            "groups": count("groups"),
            "channels": count("channels"),
            "messages": count("messages"),
            "files": count("files"),
        })
    }

    // ------------------------------------------------------------- groups

    pub fn create_group(&self, name: &str, description: &str, created_by: Option<&str>) -> Value {
        let gid = new_id(name);
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO groups (id, name, description, created_by, created_at, position) \
                 VALUES (?1, ?2, ?3, ?4, ?5, \
                   (SELECT COALESCE(MAX(position), 0) + 1 FROM groups))",
                params![gid, name, description, created_by, now()],
            )
            .unwrap();
            if let Some(user) = created_by {
                insert_member(&conn, &gid, None, "user", user, "admin");
            }
        }
        self.group(&gid).unwrap_or(Value::Null)
    }

    pub fn group(&self, group_id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, name, description, created_by, created_at, hidden FROM groups WHERE id = ?1",
            params![group_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                    "description": r.get::<_, String>(2)?,
                    "created_by": r.get::<_, Option<String>>(3)?,
                    "created_at": r.get::<_, f64>(4)?,
                    "hidden": r.get::<_, i64>(5)? != 0,
                }))
            },
        )
        .ok()
    }

    pub fn list_groups(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, created_by, created_at, hidden FROM groups ORDER BY position, name",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                "description": r.get::<_, String>(2)?,
                "created_by": r.get::<_, Option<String>>(3)?,
                "created_at": r.get::<_, f64>(4)?,
                "hidden": r.get::<_, i64>(5)? != 0,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    /// Tuck a group away in (or restore it to) the sidebar. Purely
    /// presentational — members, messages, and agent fan-out are untouched.
    pub fn set_group_hidden(&self, group_id: &str, hidden: bool) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            let changed = conn
                .execute(
                    "UPDATE groups SET hidden = ?1 WHERE id = ?2",
                    params![hidden as i64, group_id],
                )
                .unwrap();
            if changed == 0 {
                return None;
            }
        }
        self.group(group_id)
    }

    pub fn delete_group(&self, group_id: &str) -> bool {
        let file_ids;
        let deleted;
        {
            let conn = self.conn.lock().unwrap();
            let channel_ids: Vec<String> = {
                let mut stmt = conn
                    .prepare("SELECT id FROM channels WHERE group_id = ?1")
                    .unwrap();
                stmt.query_map(params![group_id], |r| r.get::<_, String>(0))
                    .unwrap()
                    .filter_map(Result::ok)
                    .collect()
            };
            deleted = conn
                .execute("DELETE FROM groups WHERE id = ?1", params![group_id])
                .unwrap()
                > 0;
            conn.execute("DELETE FROM channels WHERE group_id = ?1", params![group_id]).unwrap();
            conn.execute("DELETE FROM memberships WHERE group_id = ?1", params![group_id]).unwrap();
            file_ids = if channel_ids.is_empty() {
                Vec::new()
            } else {
                let placeholders = vec!["?"; channel_ids.len()].join(",");
                let ids: Vec<String> = {
                    let mut stmt = conn
                        .prepare(&format!("SELECT id FROM files WHERE channel_id IN ({placeholders})"))
                        .unwrap();
                    stmt.query_map(params_from_iter(channel_ids.iter()), |r| r.get::<_, String>(0))
                        .unwrap()
                        .filter_map(Result::ok)
                        .collect()
                };
                for cid in &channel_ids {
                    delete_thread_reads_for_channel(&conn, cid);
                }
                for table in ["messages", "pins", "stars", "files", "reads", "mentions"] {
                    conn.execute(
                        &format!("DELETE FROM {table} WHERE channel_id IN ({placeholders})"),
                        params_from_iter(channel_ids.iter()),
                    )
                    .unwrap();
                }
                ids
            };
        }
        self.unlink_files(&file_ids);
        deleted
    }

    // ------------------------------------------------------------- channels

    pub fn create_channel(&self, group_id: &str, name: &str, topic: &str) -> Value {
        let cid = new_id(name);
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO channels (id, group_id, name, topic, created_at, position) \
                 VALUES (?1, ?2, ?3, ?4, ?5, \
                   (SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE group_id = ?2))",
                params![cid, group_id, name, topic, now()],
            )
            .unwrap();
        }
        self.channel(&cid).unwrap_or(Value::Null)
    }

    /// Rename a channel, set its topic, and/or toggle its hidden flag
    /// (None = leave unchanged).
    pub fn update_channel(
        &self,
        channel_id: &str,
        name: Option<&str>,
        topic: Option<&str>,
        hidden: Option<bool>,
    ) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            if let Some(n) = name {
                conn.execute(
                    "UPDATE channels SET name = ?1 WHERE id = ?2",
                    params![n, channel_id],
                )
                .unwrap();
            }
            if let Some(t) = topic {
                conn.execute(
                    "UPDATE channels SET topic = ?1 WHERE id = ?2",
                    params![t, channel_id],
                )
                .unwrap();
            }
            if let Some(h) = hidden {
                conn.execute(
                    "UPDATE channels SET hidden = ?1 WHERE id = ?2",
                    params![h as i64, channel_id],
                )
                .unwrap();
            }
        }
        self.channel(channel_id)
    }

    /// Give a thread a display alias (Some = set, None = clear back to the
    /// root message's first line). Returns the updated root message, or None
    /// if `thread_id` isn't a real thread root (a top-level message).
    pub fn rename_thread(&self, thread_id: i64, alias: Option<&str>) -> Option<Value> {
        {
            let conn = self.conn.lock().unwrap();
            let is_root = conn
                .query_row(
                    "SELECT 1 FROM messages WHERE id = ?1 AND thread_id IS NULL",
                    params![thread_id],
                    |_| Ok(()),
                )
                .is_ok();
            if !is_root {
                return None;
            }
            conn.execute(
                "UPDATE messages SET thread_alias = ?1 WHERE id = ?2",
                params![alias, thread_id],
            )
            .unwrap();
        }
        self.message(thread_id)
    }

    /// Persist a manual order: each id's position becomes its array index.
    /// Ids not listed keep their old position (they sort after by name).
    pub fn reorder_groups(&self, ids: &[String]) {
        let conn = self.conn.lock().unwrap();
        for (i, id) in ids.iter().enumerate() {
            conn.execute(
                "UPDATE groups SET position = ?1 WHERE id = ?2",
                params![i as i64 + 1, id],
            )
            .unwrap();
        }
    }

    pub fn reorder_channels(&self, group_id: &str, ids: &[String]) {
        let conn = self.conn.lock().unwrap();
        for (i, id) in ids.iter().enumerate() {
            conn.execute(
                "UPDATE channels SET position = ?1 WHERE id = ?2 AND group_id = ?3",
                params![i as i64 + 1, id, group_id],
            )
            .unwrap();
        }
    }

    pub fn channel(&self, channel_id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, group_id, name, topic, created_at, hidden FROM channels WHERE id = ?1",
            params![channel_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "group_id": r.get::<_, String>(1)?,
                    "name": r.get::<_, String>(2)?, "topic": r.get::<_, String>(3)?,
                    "created_at": r.get::<_, f64>(4)?,
                    "hidden": r.get::<_, i64>(5)? != 0,
                }))
            },
        )
        .ok()
    }

    pub fn group_channels(&self, group_id: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, group_id, name, topic, created_at, hidden FROM channels \
                 WHERE group_id = ?1 ORDER BY position, name",
            )
            .unwrap();
        stmt.query_map(params![group_id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "group_id": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(2)?, "topic": r.get::<_, String>(3)?,
                "created_at": r.get::<_, f64>(4)?,
                "hidden": r.get::<_, i64>(5)? != 0,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn delete_channel(&self, channel_id: &str) -> bool {
        let file_ids: Vec<String>;
        let deleted;
        {
            let conn = self.conn.lock().unwrap();
            file_ids = {
                let mut stmt = conn
                    .prepare("SELECT id FROM files WHERE channel_id = ?1")
                    .unwrap();
                stmt.query_map(params![channel_id], |r| r.get::<_, String>(0))
                    .unwrap()
                    .filter_map(Result::ok)
                    .collect()
            };
            deleted = conn
                .execute("DELETE FROM channels WHERE id = ?1", params![channel_id])
                .unwrap()
                > 0;
            delete_thread_reads_for_channel(&conn, channel_id);
            for table in ["messages", "memberships", "pins", "stars", "files", "reads", "mentions"] {
                conn.execute(
                    &format!("DELETE FROM {table} WHERE channel_id = ?1"),
                    params![channel_id],
                )
                .unwrap();
            }
        }
        self.unlink_files(&file_ids);
        deleted
    }

    // ------------------------------------------------------------- members

    pub fn add_member(
        &self,
        group_id: &str,
        member_type: &str,
        member_id: &str,
        role: &str,
        channel_id: Option<&str>,
    ) {
        let conn = self.conn.lock().unwrap();
        insert_member(&conn, group_id, channel_id, member_type, member_id, role);
        if member_type == "user" {
            // A new member starts clean (like joining a Discord server): the
            // group's existing history isn't "unread" for them.
            conn.execute(
                "INSERT INTO reads (username, channel_id, last_read_id, updated_at) \
                 SELECT ?1, c.id, \
                   COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id), 0), ?2 \
                 FROM channels c WHERE c.group_id = ?3 \
                 ON CONFLICT(username, channel_id) DO NOTHING",
                params![member_id, now(), group_id],
            )
            .unwrap();
        }
    }

    pub fn remove_member(
        &self,
        group_id: &str,
        member_type: &str,
        member_id: &str,
        channel_id: Option<&str>,
    ) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM memberships WHERE group_id = ?1 AND member_type = ?2 \
             AND member_id = ?3 AND channel_id = ?4",
            params![group_id, member_type, member_id, channel_id.unwrap_or("")],
        )
        .unwrap()
            > 0
    }

    pub fn members(&self, group_id: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT channel_id, member_type, member_id, role, added_at FROM memberships \
                 WHERE group_id = ?1 ORDER BY member_type, member_id",
            )
            .unwrap();
        stmt.query_map(params![group_id], |r| {
            let chan: String = r.get(0)?;
            Ok(json!({
                "channel_id": if chan.is_empty() { Value::Null } else { Value::String(chan) },
                "member_type": r.get::<_, String>(1)?,
                "member_id": r.get::<_, String>(2)?,
                "role": r.get::<_, String>(3)?,
                "added_at": r.get::<_, f64>(4)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn user_groups(&self, username: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT group_id FROM memberships WHERE member_type = 'user' AND member_id = ?1",
            )
            .unwrap();
        stmt.query_map(params![username], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    pub fn user_in_group(&self, username: &str, group_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM memberships WHERE group_id = ?1 AND member_type = 'user' AND member_id = ?2 LIMIT 1",
            params![group_id, username],
            |_| Ok(()),
        )
        .is_ok()
    }

    pub fn user_is_group_admin(&self, username: &str, group_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM memberships WHERE group_id = ?1 AND member_type = 'user' \
             AND member_id = ?2 AND role = 'admin' LIMIT 1",
            params![group_id, username],
            |_| Ok(()),
        )
        .is_ok()
    }

    pub fn user_can_see_channel(&self, username: &str, channel_id: &str) -> bool {
        match self.channel(channel_id) {
            Some(chan) => {
                self.user_in_group(username, chan["group_id"].as_str().unwrap_or_default())
            }
            None => false,
        }
    }

    /// Agent ids that are members of the channel — via a group-level
    /// membership (empty channel_id) or one scoped to this exact channel.
    pub fn agents_for_channel(&self, channel_id: &str) -> Vec<String> {
        let Some(chan) = self.channel(channel_id) else {
            return Vec::new();
        };
        let group_id = chan["group_id"].as_str().unwrap_or_default().to_string();
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT member_id FROM memberships \
                 WHERE group_id = ?1 AND member_type = 'agent' \
                 AND (channel_id = '' OR channel_id = ?2)",
            )
            .unwrap();
        stmt.query_map(params![group_id, channel_id], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    // ------------------------------------------------------------- messages

    pub fn add_message(
        &self,
        channel_id: &str,
        text: &str,
        author_type: &str,
        author_id: &str,
        author_name: Option<&str>,
        thread_id: Option<i64>,
        attachments: &[NewAttachment],
    ) -> Value {
        self.add_message_with_meta(
            channel_id,
            text,
            author_type,
            author_id,
            author_name,
            thread_id,
            attachments,
            None,
        )
    }

    pub fn add_message_with_meta(
        &self,
        channel_id: &str,
        text: &str,
        author_type: &str,
        author_id: &str,
        author_name: Option<&str>,
        thread_id: Option<i64>,
        attachments: &[NewAttachment],
        meta: Option<&Value>,
    ) -> Value {
        let ts = now();
        let meta_json = meta
            .filter(|m| !m.is_null())
            .map(|m| m.to_string());
        let mut stored_files = Vec::new();
        let message_id;
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO messages (channel_id, thread_id, author_type, author_id, author_name, text, ts, meta) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    channel_id,
                    thread_id,
                    author_type,
                    author_id,
                    author_name,
                    text,
                    ts,
                    meta_json
                ],
            )
            .unwrap();
            message_id = conn.last_insert_rowid();
            for att in attachments {
                let file_id = new_token();
                std::fs::create_dir_all(&self.files_dir).ok();
                std::fs::write(self.files_dir.join(&file_id), &att.data).ok();
                conn.execute(
                    "INSERT INTO files (id, channel_id, message_id, filename, mime, size, ts) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![file_id, channel_id, message_id, att.filename, att.mime, att.data.len() as i64, ts],
                )
                .unwrap();
                stored_files.push(json!({
                    "id": file_id, "filename": att.filename,
                    "mime": att.mime, "size": att.data.len(),
                }));
            }
        }
        json!({
            "id": message_id,
            "channel_id": channel_id,
            "thread_id": thread_id,
            "author_type": author_type,
            "author_id": author_id,
            "author_name": author_name,
            "text": text,
            "ts": ts,
            "meta": meta.cloned().unwrap_or(Value::Null),
            "attachments": stored_files,
        })
    }

    /// Merge ``patch`` into a message's ``meta`` JSON and return the updated message.
    pub fn update_message_meta(&self, message_id: i64, patch: &Value) -> Option<Value> {
        let existing = self.message(message_id)?;
        let mut meta = existing.get("meta").cloned().unwrap_or(Value::Null);
        if !meta.is_object() {
            meta = json!({});
        }
        if let (Some(obj), Some(patch_obj)) = (meta.as_object_mut(), patch.as_object()) {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE messages SET meta = ?1 WHERE id = ?2",
                params![meta.to_string(), message_id],
            )
            .ok()?;
        }
        self.message(message_id)
    }

    /// Find a message whose meta.options_id matches (for agent-side resolve).
    pub fn find_message_by_options_id(&self, options_id: &str) -> Option<i64> {
        if options_id.is_empty() {
            return None;
        }
        let conn = self.conn.lock().unwrap();
        // SQLite json1: meta is a JSON text column.
        conn.query_row(
            "SELECT id FROM messages WHERE meta IS NOT NULL \
             AND json_extract(meta, '$.options_id') = ?1 \
             ORDER BY id DESC LIMIT 1",
            params![options_id],
            |r| r.get(0),
        )
        .ok()
    }

    pub fn message(&self, message_id: i64) -> Option<Value> {
        let msg = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                &format!("SELECT {MSG_COLS}, thread_alias FROM messages WHERE id = ?1"),
                params![message_id],
                |r| {
                    let mut m = message_row(r, 0)?;
                    m["alias"] = json!(r.get::<_, Option<String>>(9)?);
                    Ok(m)
                },
            )
            .ok()?
        };
        Some(self.attach_files(vec![msg]).remove(0))
    }

    /// Newest-last page of a channel's top level (`thread_id` None) or one
    /// thread. Top-level pages carry each root's reply count.
    pub fn messages(
        &self,
        channel_id: &str,
        thread_id: Option<i64>,
        before_id: Option<i64>,
        limit: usize,
    ) -> Vec<Value> {
        let mut rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            let mut sql = format!("SELECT {MSG_COLS} FROM messages WHERE channel_id = ?1 AND ");
            sql.push_str(if thread_id.is_some() { "thread_id = ?2" } else { "thread_id IS NULL" });
            let mut p: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(channel_id.to_string())];
            if let Some(t) = thread_id {
                p.push(Box::new(t));
            }
            if let Some(b) = before_id {
                sql.push_str(&format!(" AND id < ?{}", p.len() + 1));
                p.push(Box::new(b));
            }
            sql.push_str(&format!(" ORDER BY id DESC LIMIT ?{}", p.len() + 1));
            p.push(Box::new(limit as i64));
            let mut stmt = conn.prepare(&sql).unwrap();
            stmt.query_map(params_from_iter(p.iter().map(|b| b.as_ref())), |r| message_row(r, 0))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
        };
        rows.reverse();
        let mut out = self.attach_files(rows);
        if thread_id.is_none() && !out.is_empty() {
            let ids: Vec<i64> = out.iter().filter_map(|m| m["id"].as_i64()).collect();
            let placeholders = vec!["?"; ids.len()].join(",");
            let counts: std::collections::HashMap<i64, i64> = {
                let conn = self.conn.lock().unwrap();
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT thread_id, COUNT(*) FROM messages WHERE thread_id IN ({placeholders}) GROUP BY thread_id"
                    ))
                    .unwrap();
                stmt.query_map(params_from_iter(ids.iter()), |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })
                .unwrap()
                .filter_map(Result::ok)
                .collect()
            };
            for m in &mut out {
                let id = m["id"].as_i64().unwrap_or_default();
                m["reply_count"] = json!(counts.get(&id).copied().unwrap_or(0));
            }
        }
        out
    }

    pub fn thread_size(&self, thread_id: i64) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE thread_id = ?1",
            params![thread_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    // ------------------------------------------------------------- search

    /// Full-text search over message text, best match first (bm25) unless
    /// `newest_first`. Each hit is the message plus its channel/group names
    /// and a `snippet` where matched terms are wrapped in \u{1}…\u{2} (clients
    /// escape the text, then swap the markers for their highlight markup).
    ///
    /// `channel_id`/`group_id`/`author` narrow the scope. `agent_id` restricts
    /// hits to channels that agent is a member of — the same visibility rule
    /// as inbound fan-out — for the agent-protocol search frame. `match_any`
    /// switches from all-terms to any-term matching (AI answer retrieval).
    #[allow(clippy::too_many_arguments)]
    pub fn search_messages(
        &self,
        query: &str,
        match_any: bool,
        channel_id: Option<&str>,
        group_id: Option<&str>,
        author: Option<&str>,
        agent_id: Option<&str>,
        newest_first: bool,
        limit: usize,
        offset: usize,
    ) -> Vec<Value> {
        let fts = if match_any { fts_query_any(query) } else { fts_query(query) };
        let Some(fts) = fts else {
            return Vec::new();
        };
        let conn = self.conn.lock().unwrap();
        let mut sql = String::from(
            "SELECT m.id, m.channel_id, m.thread_id, m.author_type, m.author_id, \
               m.author_name, m.text, m.ts, m.meta, \
               c.name, c.group_id, COALESCE(g.name, ''), \
               snippet(messages_fts, 0, char(1), char(2), '…', 16) \
             FROM messages_fts \
             JOIN messages m ON m.id = messages_fts.rowid \
             JOIN channels c ON c.id = m.channel_id \
             LEFT JOIN groups g ON g.id = c.group_id \
             WHERE messages_fts MATCH ?1",
        );
        let mut p: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(fts)];
        if let Some(cid) = channel_id {
            sql.push_str(&format!(" AND m.channel_id = ?{}", p.len() + 1));
            p.push(Box::new(cid.to_string()));
        }
        if let Some(gid) = group_id {
            sql.push_str(&format!(" AND c.group_id = ?{}", p.len() + 1));
            p.push(Box::new(gid.to_string()));
        }
        if let Some(a) = author {
            let i = p.len() + 1;
            sql.push_str(&format!(" AND (m.author_id = ?{i} OR m.author_name = ?{i})"));
            p.push(Box::new(a.to_string()));
        }
        if let Some(agent) = agent_id {
            let i = p.len() + 1;
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM memberships ms \
                   WHERE ms.member_type = 'agent' AND ms.member_id = ?{i} \
                   AND ms.group_id = c.group_id \
                   AND (ms.channel_id = '' OR ms.channel_id = m.channel_id))"
            ));
            p.push(Box::new(agent.to_string()));
        }
        sql.push_str(if newest_first { " ORDER BY m.id DESC" } else { " ORDER BY rank" });
        sql.push_str(&format!(" LIMIT ?{} OFFSET ?{}", p.len() + 1, p.len() + 2));
        p.push(Box::new(limit as i64));
        p.push(Box::new(offset as i64));
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(params_from_iter(p.iter().map(|b| b.as_ref())), |r| {
            let mut msg = message_row(r, 0)?;
            msg["channel_name"] = json!(r.get::<_, String>(9)?);
            msg["group_id"] = json!(r.get::<_, String>(10)?);
            msg["group_name"] = json!(r.get::<_, String>(11)?);
            msg["snippet"] = json!(r.get::<_, String>(12)?);
            Ok(msg)
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    /// Channels whose name or topic contains `query` (case-insensitive).
    pub fn search_channels(&self, query: &str, limit: usize) -> Vec<Value> {
        let pattern = like_pattern(query);
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.group_id, c.name, c.topic, c.hidden, COALESCE(g.name, '') \
                 FROM channels c LEFT JOIN groups g ON g.id = c.group_id \
                 WHERE c.name LIKE ?1 ESCAPE '\\' OR c.topic LIKE ?1 ESCAPE '\\' \
                 ORDER BY c.name LIMIT ?2",
            )
            .unwrap();
        stmt.query_map(params![pattern, limit as i64], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "group_id": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(2)?,
                "topic": r.get::<_, String>(3)?,
                "hidden": r.get::<_, i64>(4)? != 0,
                "group_name": r.get::<_, String>(5)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    /// Groups whose name or description contains `query` (case-insensitive).
    pub fn search_groups(&self, query: &str, limit: usize) -> Vec<Value> {
        let pattern = like_pattern(query);
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, description, hidden FROM groups \
                 WHERE name LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\' \
                 ORDER BY name LIMIT ?2",
            )
            .unwrap();
        stmt.query_map(params![pattern, limit as i64], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "description": r.get::<_, String>(2)?,
                "hidden": r.get::<_, i64>(3)? != 0,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    // ------------------------------------------------------------- files

    pub fn file(&self, file_id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, channel_id, message_id, filename, mime, size, ts FROM files WHERE id = ?1",
            params![file_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "channel_id": r.get::<_, String>(1)?,
                    "message_id": r.get::<_, i64>(2)?, "filename": r.get::<_, String>(3)?,
                    "mime": r.get::<_, String>(4)?, "size": r.get::<_, i64>(5)?,
                    "ts": r.get::<_, f64>(6)?,
                }))
            },
        )
        .ok()
    }

    pub fn file_path(&self, file_id: &str) -> PathBuf {
        self.files_dir.join(file_id)
    }

    fn attach_files(&self, mut messages: Vec<Value>) -> Vec<Value> {
        if messages.is_empty() {
            return messages;
        }
        let ids: Vec<i64> = messages.iter().filter_map(|m| m["id"].as_i64()).collect();
        let placeholders = vec!["?"; ids.len()].join(",");
        let mut by_message: std::collections::HashMap<i64, Vec<Value>> = Default::default();
        {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT message_id, id, filename, mime, size FROM files \
                     WHERE message_id IN ({placeholders}) ORDER BY rowid"
                ))
                .unwrap();
            let rows = stmt
                .query_map(params_from_iter(ids.iter()), |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        json!({
                            "id": r.get::<_, String>(1)?, "filename": r.get::<_, String>(2)?,
                            "mime": r.get::<_, String>(3)?, "size": r.get::<_, i64>(4)?,
                        }),
                    ))
                })
                .unwrap()
                .filter_map(Result::ok);
            for (mid, f) in rows {
                by_message.entry(mid).or_default().push(f);
            }
        }
        for m in &mut messages {
            let id = m["id"].as_i64().unwrap_or_default();
            m["attachments"] = Value::Array(by_message.remove(&id).unwrap_or_default());
        }
        messages
    }

    fn unlink_files(&self, file_ids: &[String]) {
        for id in file_ids {
            std::fs::remove_file(self.files_dir.join(id)).ok();
        }
    }

    // ------------------------------------------------------------- stars

    pub fn star_message(&self, username: &str, channel_id: &str, message_id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO stars (username, channel_id, message_id, starred_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(username, message_id) DO NOTHING",
            params![username, channel_id, message_id, now()],
        )
        .unwrap()
            > 0
    }

    pub fn unstar_message(&self, username: &str, message_id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM stars WHERE username = ?1 AND message_id = ?2",
            params![username, message_id],
        )
        .unwrap()
            > 0
    }

    /// The user's starred messages in a channel (newest star first). Thread
    /// replies carry their `root` message too so the UI can open the thread.
    pub fn user_stars(&self, username: &str, channel_id: &str) -> Vec<Value> {
        let rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT m.id, m.channel_id, m.thread_id, m.author_type, m.author_id, \
                     m.author_name, m.text, m.ts, m.meta, s.starred_at, \
                     r.id, r.channel_id, r.thread_id, r.author_type, r.author_id, \
                     r.author_name, r.text, r.ts, r.meta \
                     FROM stars s JOIN messages m ON m.id = s.message_id \
                     LEFT JOIN messages r ON r.id = m.thread_id \
                     WHERE s.username = ?1 AND s.channel_id = ?2 ORDER BY s.starred_at DESC",
                )
                .unwrap();
            stmt.query_map(params![username, channel_id], |r| {
                let mut star = message_row(r, 0)?;
                star["starred_at"] = json!(r.get::<_, f64>(9)?);
                star["root"] = match r.get::<_, Option<i64>>(10)? {
                    Some(_) => message_row(r, 10)?,
                    None => Value::Null,
                };
                Ok(star)
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect()
        };
        self.attach_files(rows)
    }

    // ------------------------------------------------------------- reads

    /// Advance the user's read marker (None = channel max id). Monotonic —
    /// a stale ack never moves it backwards. Returns the effective marker.
    pub fn mark_read(&self, username: &str, channel_id: &str, message_id: Option<i64>) -> i64 {
        let conn = self.conn.lock().unwrap();
        let target = match message_id {
            Some(id) => id.max(0),
            None => conn
                .query_row(
                    "SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ?1",
                    params![channel_id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0),
        };
        conn.execute(
            "INSERT INTO reads (username, channel_id, last_read_id, updated_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(username, channel_id) DO UPDATE SET \
             last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = excluded.updated_at",
            params![username, channel_id, target, now()],
        )
        .unwrap();
        conn.query_row(
            "SELECT last_read_id FROM reads WHERE username = ?1 AND channel_id = ?2",
            params![username, channel_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Per-channel unread state: `{channel_id: {count, mentions, last_read_id}}`.
    /// Unread = **top-level** messages newer than the marker, own messages
    /// excluded (thread replies surface via thread unreads, not here).
    /// Mentions count @you messages (any thread) newer than the marker.
    pub fn unread_counts(&self, username: &str, channel_ids: &[String]) -> Value {
        if channel_ids.is_empty() {
            return json!({});
        }
        let placeholders = vec!["?"; channel_ids.len()].join(",");
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT c.id, COALESCE(r.last_read_id, 0), COUNT(m.id), \
                   (SELECT COUNT(*) FROM mentions mn WHERE mn.channel_id = c.id \
                     AND mn.username = ?1 AND mn.message_id > COALESCE(r.last_read_id, 0)) \
                 FROM channels c \
                 LEFT JOIN reads r ON r.username = ?1 AND r.channel_id = c.id \
                 LEFT JOIN messages m ON m.channel_id = c.id \
                   AND m.thread_id IS NULL \
                   AND m.id > COALESCE(r.last_read_id, 0) \
                   AND NOT (m.author_type = 'user' AND m.author_id = ?2) \
                 WHERE c.id IN ({placeholders}) GROUP BY c.id"
            ))
            .unwrap();
        let mut p: Vec<Box<dyn rusqlite::ToSql>> =
            vec![Box::new(username.to_string()), Box::new(username.to_string())];
        for id in channel_ids {
            p.push(Box::new(id.clone()));
        }
        let mut out = serde_json::Map::new();
        let rows = stmt
            .query_map(params_from_iter(p.iter().map(|b| b.as_ref())), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .filter_map(Result::ok);
        for (cid, last_read, count, mentions) in rows {
            out.insert(
                cid,
                json!({"count": count, "mentions": mentions, "last_read_id": last_read}),
            );
        }
        Value::Object(out)
    }

    // ---------------------------------------------------------- mentions

    /// Record which users a message @mentioned (called by the hub at post
    /// time with already-matched usernames).
    pub fn add_mentions(&self, message_id: i64, channel_id: &str, usernames: &[String]) {
        if usernames.is_empty() {
            return;
        }
        let conn = self.conn.lock().unwrap();
        for user in usernames {
            conn.execute(
                "INSERT INTO mentions (message_id, channel_id, username) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(message_id, username) DO NOTHING",
                params![message_id, channel_id, user],
            )
            .unwrap();
        }
    }

    // ------------------------------------------------------- thread reads

    /// Advance the user's per-thread read marker (None = thread max id).
    /// Monotonic like `mark_read`. Returns the effective marker.
    pub fn mark_thread_read(
        &self,
        username: &str,
        thread_id: i64,
        message_id: Option<i64>,
    ) -> i64 {
        let conn = self.conn.lock().unwrap();
        let target = match message_id {
            Some(id) => id.max(0),
            None => conn
                .query_row(
                    "SELECT COALESCE(MAX(id), 0) FROM messages WHERE thread_id = ?1",
                    params![thread_id],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0),
        };
        conn.execute(
            "INSERT INTO thread_reads (username, thread_id, last_read_id, updated_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(username, thread_id) DO UPDATE SET \
             last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = excluded.updated_at",
            params![username, thread_id, target, now()],
        )
        .unwrap();
        conn.query_row(
            "SELECT last_read_id FROM thread_reads WHERE username = ?1 AND thread_id = ?2",
            params![username, thread_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Dismiss a thread from the user's inbox/sidebar. The messages stay in
    /// the channel; the row just stops coming back from `my_threads`.
    pub fn hide_thread(&self, username: &str, thread_id: i64) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO thread_hides (username, thread_id, hidden_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(username, thread_id) DO NOTHING",
            params![username, thread_id, now()],
        )
        .unwrap();
    }

    pub fn unhide_thread(&self, username: &str, thread_id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM thread_hides WHERE username = ?1 AND thread_id = ?2",
            params![username, thread_id],
        )
        .unwrap()
            > 0
    }

    /// The user's threads inbox: every thread they participate in (authored
    /// the root or any reply), newest activity first, minus threads they
    /// dismissed. Each row is the root message plus channel/group names,
    /// reply stats, and the user's unread reply count (own replies excluded).
    pub fn my_threads(&self, username: &str, limit: usize) -> Vec<Value> {
        let rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT r.id, r.channel_id, r.thread_id, r.author_type, r.author_id, \
                       r.author_name, r.text, r.ts, r.meta, \
                       c.name, c.group_id, COALESCE(g.name, ''), \
                       COUNT(m.id), MAX(m.id), MAX(m.ts), \
                       COALESCE(tr.last_read_id, 0), \
                       SUM(CASE WHEN m.id > COALESCE(tr.last_read_id, 0) \
                             AND NOT (m.author_type = 'user' AND m.author_id = ?1) \
                           THEN 1 ELSE 0 END), \
                       r.thread_alias \
                     FROM messages r \
                     JOIN channels c ON c.id = r.channel_id \
                     LEFT JOIN groups g ON g.id = c.group_id \
                     JOIN messages m ON m.thread_id = r.id \
                     LEFT JOIN thread_reads tr ON tr.username = ?1 AND tr.thread_id = r.id \
                     WHERE r.thread_id IS NULL AND ( \
                       (r.author_type = 'user' AND r.author_id = ?1) \
                       OR EXISTS (SELECT 1 FROM messages p WHERE p.thread_id = r.id \
                            AND p.author_type = 'user' AND p.author_id = ?1)) \
                     AND NOT EXISTS (SELECT 1 FROM thread_hides h \
                            WHERE h.username = ?1 AND h.thread_id = r.id) \
                     GROUP BY r.id ORDER BY MAX(m.id) DESC LIMIT ?2",
                )
                .unwrap();
            stmt.query_map(params![username, limit as i64], |r| {
                let mut root = message_row(r, 0)?;
                root["reply_count"] = json!(r.get::<_, i64>(12)?);
                root["alias"] = json!(r.get::<_, Option<String>>(17)?);
                Ok(json!({
                    "root": root,
                    "channel_id": r.get::<_, String>(1)?,
                    "channel_name": r.get::<_, String>(9)?,
                    "group_id": r.get::<_, String>(10)?,
                    "group_name": r.get::<_, String>(11)?,
                    "reply_count": r.get::<_, i64>(12)?,
                    "last_reply_id": r.get::<_, i64>(13)?,
                    "last_reply_ts": r.get::<_, f64>(14)?,
                    "last_read_id": r.get::<_, i64>(15)?,
                    "unread": r.get::<_, i64>(16)?,
                }))
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect()
        };
        rows
    }

    // ------------------------------------------------------------- pins

    pub fn pin_message(&self, channel_id: &str, message_id: i64, pinned_by: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO pins (channel_id, message_id, pinned_by, pinned_at) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(channel_id, message_id) DO NOTHING",
            params![channel_id, message_id, pinned_by, now()],
        )
        .unwrap()
            > 0
    }

    pub fn unpin_message(&self, channel_id: &str, message_id: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM pins WHERE channel_id = ?1 AND message_id = ?2",
            params![channel_id, message_id],
        )
        .unwrap()
            > 0
    }

    pub fn pin_count(&self, channel_id: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM pins WHERE channel_id = ?1",
            params![channel_id],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    pub fn channel_pins(&self, channel_id: &str) -> Vec<Value> {
        let rows: Vec<Value> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT m.id, m.channel_id, m.thread_id, m.author_type, m.author_id, \
                     m.author_name, m.text, m.ts, m.meta, p.pinned_by, p.pinned_at, \
                     (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id) \
                     FROM pins p JOIN messages m ON m.id = p.message_id \
                     WHERE p.channel_id = ?1 ORDER BY p.pinned_at DESC",
                )
                .unwrap();
            stmt.query_map(params![channel_id], |r| {
                let mut msg = message_row(r, 0)?;
                msg["pinned_by"] = json!(r.get::<_, Option<String>>(9)?);
                msg["pinned_at"] = json!(r.get::<_, f64>(10)?);
                msg["reply_count"] = json!(r.get::<_, i64>(11)?);
                Ok(msg)
            })
            .unwrap()
            .filter_map(Result::ok)
            .collect()
        };
        self.attach_files(rows)
    }

    // ------------------------------------------------------------- agents

    /// Remember an agent seen on a connection (upsert; refreshes name/flags).
    pub fn upsert_agent(
        &self,
        id: &str,
        name: &str,
        source: &str,
        requires_mention: bool,
        has_avatar: bool,
        avatar_v: i64,
    ) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agents (id, name, source, requires_mention, last_seen, has_avatar, avatar_v) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, source = excluded.source, \
             requires_mention = excluded.requires_mention, last_seen = excluded.last_seen, \
             has_avatar = excluded.has_avatar, avatar_v = excluded.avatar_v",
            params![id, name, source, requires_mention as i64, now(), has_avatar as i64, avatar_v],
        )
        .unwrap();
    }

    pub fn known_agents(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, source, requires_mention, last_seen, has_avatar, avatar_v \
                 FROM agents ORDER BY name",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                "source": r.get::<_, String>(2)?,
                "requires_mention": r.get::<_, i64>(3)? != 0,
                "last_seen": r.get::<_, f64>(4)?,
                "has_avatar": r.get::<_, i64>(5)? != 0,
                "avatar_v": r.get::<_, i64>(6)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn agent(&self, id: &str) -> Option<Value> {
        self.known_agents().into_iter().find(|a| a["id"] == id)
    }

    pub fn remove_agent(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM agents WHERE id = ?1", params![id]).unwrap() > 0
    }
}

/// thread_reads/thread_hides have no channel_id column; scope the delete via
/// the thread's root message. Must run before the channel's messages are
/// deleted.
fn delete_thread_reads_for_channel(conn: &Connection, channel_id: &str) {
    for table in ["thread_reads", "thread_hides"] {
        conn.execute(
            &format!(
                "DELETE FROM {table} WHERE thread_id IN \
                 (SELECT id FROM messages WHERE channel_id = ?1)"
            ),
            params![channel_id],
        )
        .unwrap();
    }
}

fn insert_member(
    conn: &Connection,
    group_id: &str,
    channel_id: Option<&str>,
    member_type: &str,
    member_id: &str,
    role: &str,
) {
    conn.execute(
        "INSERT INTO memberships (group_id, channel_id, member_type, member_id, role, added_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(group_id, channel_id, member_type, member_id) DO UPDATE SET role = excluded.role",
        params![group_id, channel_id.unwrap_or(""), member_type, member_id, role, now()],
    )
    .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    #[test]
    fn group_channel_crud_and_cascade() {
        let s = store();
        let g = s.create_group("Health", "fitness stuff", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        assert!(gid.starts_with("health-"));
        assert!(s.user_is_group_admin("tom", gid));
        let c = s.create_channel(gid, "workouts", "daily");
        let cid = c["id"].as_str().unwrap();
        s.add_message(cid, "hello", "user", "tom", Some("Tom"), None, &[]);
        assert_eq!(s.messages(cid, None, None, 50).len(), 1);
        assert!(s.delete_group(gid));
        assert!(s.group(gid).is_none());
        assert!(s.channel(cid).is_none());
        assert_eq!(s.messages(cid, None, None, 50).len(), 0);
    }

    #[test]
    fn membership_scoping() {
        let s = store();
        let g = s.create_group("Ops", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c1 = s.create_channel(gid, "alpha", "");
        let c2 = s.create_channel(gid, "beta", "");
        let c1id = c1["id"].as_str().unwrap();
        let c2id = c2["id"].as_str().unwrap();
        s.add_member(gid, "agent", "bot-a", "member", None); // whole group
        s.add_member(gid, "agent", "bot-b", "member", Some(c1id)); // one channel
        assert_eq!(s.agents_for_channel(c1id).len(), 2);
        assert_eq!(s.agents_for_channel(c2id), vec!["bot-a".to_string()]);
        assert!(s.user_in_group("tom", gid));
        assert!(!s.user_in_group("alice", gid));
    }

    #[test]
    fn threads_and_reply_counts() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        s.add_message(cid, "reply1", "agent", "bot", Some("Bot"), Some(root_id), &[]);
        s.add_message(cid, "reply2", "user", "tom", None, Some(root_id), &[]);
        let top = s.messages(cid, None, None, 50);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0]["reply_count"], 2);
        let thread = s.messages(cid, Some(root_id), None, 50);
        assert_eq!(thread.len(), 2);
        assert_eq!(s.thread_size(root_id), 2);
    }

    #[test]
    fn rename_thread_sets_clears_and_rejects_non_roots() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        let reply = s.add_message(cid, "reply", "user", "tom", None, Some(root_id), &[]);
        let reply_id = reply["id"].as_i64().unwrap();

        // Set an alias — it comes back on the message and in the inbox row.
        let updated = s.rename_thread(root_id, Some("Launch plan")).unwrap();
        assert_eq!(updated["alias"], "Launch plan");
        let rows = s.my_threads("tom", 50);
        assert_eq!(rows[0]["root"]["alias"], "Launch plan");

        // Clearing it drops back to null.
        let cleared = s.rename_thread(root_id, None).unwrap();
        assert!(cleared["alias"].is_null());
        assert!(s.my_threads("tom", 50)[0]["root"]["alias"].is_null());

        // A reply id isn't a thread root — refuse it.
        assert!(s.rename_thread(reply_id, Some("nope")).is_none());
        assert!(s.rename_thread(999_999, Some("nope")).is_none());
    }

    #[test]
    fn fts_query_quotes_terms_and_neutralizes_syntax() {
        assert_eq!(fts_query("hello world"), Some("\"hello\" \"world\"*".into()));
        assert_eq!(fts_query("\"exact phrase\" tail"), Some("\"exact phrase\" \"tail\"*".into()));
        // Operators and column syntax arrive as inert quoted terms.
        assert_eq!(fts_query("a AND b:c -d"), Some("\"a\" \"AND\" \"b:c\" \"-d\"*".into()));
        assert_eq!(fts_query("   "), None);
        assert_eq!(fts_query("\"\""), None);
    }

    #[test]
    fn search_messages_matches_stems_scopes_and_syncs() {
        let s = store();
        let g = s.create_group("Ops", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c1 = s.create_channel(gid, "alpha", "");
        let c2 = s.create_channel(gid, "beta", "");
        let c1id = c1["id"].as_str().unwrap();
        let c2id = c2["id"].as_str().unwrap();
        s.add_message(c1id, "we deployed the new build", "user", "tom", Some("Tom"), None, &[]);
        s.add_message(c2id, "the bot deploys on fridays", "agent", "bot", Some("Bot"), None, &[]);
        s.add_message(c2id, "unrelated chatter", "user", "tom", None, None, &[]);

        // Porter stemming: "deploy" finds both variants; hits carry names + snippet.
        let hits = s.search_messages("deploy", false, None, None, None, None, false, 10, 0);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["group_name"], "Ops");
        assert!(hits[0]["channel_name"].as_str().is_some());
        assert!(hits[0]["snippet"].as_str().unwrap().contains('\u{1}'));

        // Channel and author scoping.
        assert_eq!(s.search_messages("deploy", false, Some(c1id), None, None, None, false, 10, 0).len(), 1);
        assert_eq!(s.search_messages("deploy", false, None, Some(gid), None, None, false, 10, 0).len(), 2);
        assert_eq!(s.search_messages("deploy", false, None, None, Some("bot"), None, false, 10, 0).len(), 1);

        // Agent visibility: bot-b is only in beta, so alpha's hit is invisible.
        s.add_member(gid, "agent", "bot-b", "member", Some(c2id));
        let scoped = s.search_messages("deploy", false, None, None, None, Some("bot-b"), false, 10, 0);
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0]["channel_id"].as_str().unwrap(), c2id);

        // newest_first orders by id descending.
        let newest = s.search_messages("deploy", false, None, None, None, None, true, 10, 0);
        assert!(newest[0]["id"].as_i64().unwrap() > newest[1]["id"].as_i64().unwrap());

        // A raw query full of FTS syntax must not panic, just match nothing.
        assert!(s.search_messages("AND NOT (", false, None, None, None, None, false, 10, 0).is_empty());

        // match_any: recall mode hits messages containing either word
        // ("deployed" stems onto "deploys" too, so all three rows hit).
        let any = s.search_messages("deployed chatter", true, None, None, None, None, false, 10, 0);
        assert_eq!(any.len(), 3);

        // Deleting the group cascades into the index via the triggers.
        assert!(s.delete_group(gid));
        assert!(s.search_messages("deploy", false, None, None, None, None, false, 10, 0).is_empty());
    }

    #[test]
    fn search_backfills_history_from_a_pre_index_database() {
        // A database written before the FTS index existed: old schema, no
        // messages_fts, no triggers, user_version 0 — like any live install
        // upgrading to the search release. Opening it must backfill the index
        // so pre-existing history is searchable, not just new writes.
        let dir = std::env::temp_dir().join(format!("agora_fts_migrate_{}", new_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agora.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, \
                   description TEXT NOT NULL DEFAULT '', created_by TEXT, \
                   created_at REAL NOT NULL, position INTEGER NOT NULL DEFAULT 0, \
                   hidden INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE channels (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, \
                   name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', \
                   created_at REAL NOT NULL, position INTEGER NOT NULL DEFAULT 0, \
                   hidden INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, \
                   channel_id TEXT NOT NULL, thread_id INTEGER, author_type TEXT NOT NULL, \
                   author_id TEXT NOT NULL, author_name TEXT, text TEXT NOT NULL, \
                   ts REAL NOT NULL, meta TEXT);
                 INSERT INTO groups VALUES ('g1', 'Home', '', NULL, 0, 0, 0);
                 INSERT INTO channels VALUES ('c1', 'g1', 'pets', '', 0, 0, 0);
                 INSERT INTO messages (channel_id, author_type, author_id, text, ts) \
                   VALUES ('c1', 'user', 'me', 'my pet turtle escaped', 0);",
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        let hits = s.search_messages("pet", false, None, None, None, None, false, 10, 0);
        assert_eq!(hits.len(), 1, "pre-index history must be backfilled");
        assert_eq!(hits[0]["text"], "my pet turtle escaped");
        // Reopening doesn't rebuild again (version marker advanced) but the
        // index still works, triggers included.
        drop(s);
        let s = Store::open(&path).unwrap();
        s.add_message("c1", "the pet is back", "user", "me", None, None, &[]);
        assert_eq!(s.search_messages("pet", false, None, None, None, None, false, 10, 0).len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn search_channels_and_groups_by_name_topic_description() {
        let s = store();
        let g = s.create_group("Health", "fitness and 100% wellness", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        s.create_channel(gid, "workouts", "daily training");
        s.create_channel(gid, "meals", "");

        assert_eq!(s.search_channels("WORK", 10).len(), 1); // case-insensitive name
        let by_topic = s.search_channels("training", 10);
        assert_eq!(by_topic.len(), 1);
        assert_eq!(by_topic[0]["group_name"], "Health");
        assert_eq!(s.search_groups("fitness", 10).len(), 1); // by description
        // LIKE wildcards in input are literal, not "match everything".
        assert!(s.search_channels("%", 10).is_empty());
        assert_eq!(s.search_groups("100%", 10).len(), 1);
    }

    #[test]
    fn reads_monotonic_and_seeded() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let m1 = s.add_message(cid, "one", "agent", "bot", None, None, &[]);
        let id1 = m1["id"].as_i64().unwrap();
        s.add_message(cid, "two", "agent", "bot", None, None, &[]);
        // New member is seeded with everything read.
        s.add_member(gid, "user", "alice", "member", None);
        let unread = s.unread_counts("alice", &[cid.to_string()]);
        assert_eq!(unread[cid]["count"], 0);
        // tom created the group before messages existed: no seed row, all unread.
        let unread_tom = s.unread_counts("tom", &[cid.to_string()]);
        assert_eq!(unread_tom[cid]["count"], 2);
        let marker = s.mark_read("tom", cid, Some(id1));
        assert_eq!(marker, id1);
        // Stale ack cannot regress.
        assert_eq!(s.mark_read("tom", cid, Some(0)), id1);
        assert_eq!(s.unread_counts("tom", &[cid.to_string()])[cid]["count"], 1);
    }

    #[test]
    fn unread_counts_top_level_only_with_mentions() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root", "agent", "bot", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        // Thread replies don't inflate the channel badge...
        s.add_message(cid, "reply", "agent", "bot", None, Some(root_id), &[]);
        let m = s.add_message(cid, "hey @tom", "agent", "bot", None, Some(root_id), &[]);
        s.add_mentions(m["id"].as_i64().unwrap(), cid, &["tom".to_string()]);
        let u = s.unread_counts("tom", &[cid.to_string()]);
        assert_eq!(u[cid]["count"], 1); // just the root
        // ...but an @mention inside a thread still counts as a mention.
        assert_eq!(u[cid]["mentions"], 1);
        s.mark_read("tom", cid, None);
        let u = s.unread_counts("tom", &[cid.to_string()]);
        assert_eq!(u[cid]["count"], 0);
        assert_eq!(u[cid]["mentions"], 0);
    }

    #[test]
    fn thread_reads_monotonic() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        let r1 = s.add_message(cid, "r1", "agent", "bot", None, Some(root_id), &[]);
        s.add_message(cid, "r2", "agent", "bot", None, Some(root_id), &[]);
        let id1 = r1["id"].as_i64().unwrap();
        assert_eq!(s.mark_thread_read("tom", root_id, Some(id1)), id1);
        // Stale ack cannot regress; None advances to the thread max.
        assert_eq!(s.mark_thread_read("tom", root_id, Some(0)), id1);
        let max = s.mark_thread_read("tom", root_id, None);
        assert!(max > id1);
    }

    #[test]
    fn my_threads_participation_and_unreads() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        // Thread A: tom's root, bot replies -> participant with unreads.
        let a = s.add_message(cid, "mine", "user", "tom", None, None, &[]);
        let a_id = a["id"].as_i64().unwrap();
        s.add_message(cid, "re A", "agent", "bot", Some("Bot"), Some(a_id), &[]);
        // Thread B: bot root and replies only -> not tom's thread.
        let b = s.add_message(cid, "bots", "agent", "bot", None, None, &[]);
        let b_id = b["id"].as_i64().unwrap();
        s.add_message(cid, "re B", "agent", "bot2", None, Some(b_id), &[]);
        // Thread C: bot root, tom replied -> participant.
        let cmsg = s.add_message(cid, "topic", "agent", "bot", None, None, &[]);
        let c_id = cmsg["id"].as_i64().unwrap();
        s.add_message(cid, "me too", "user", "tom", None, Some(c_id), &[]);
        let threads = s.my_threads("tom", 50);
        let ids: Vec<i64> = threads.iter().map(|t| t["root"]["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![c_id, a_id]); // newest activity first, no thread B
        let thread_a = threads.iter().find(|t| t["root"]["id"] == a_id).unwrap();
        assert_eq!(thread_a["unread"], 1);
        assert_eq!(thread_a["channel_name"], "main");
        assert_eq!(thread_a["group_name"], "G");
        // Own reply in C is not unread to tom.
        let thread_c = threads.iter().find(|t| t["root"]["id"] == c_id).unwrap();
        assert_eq!(thread_c["unread"], 0);
        // Acking A clears its unread.
        s.mark_thread_read("tom", a_id, None);
        let threads = s.my_threads("tom", 50);
        let thread_a = threads.iter().find(|t| t["root"]["id"] == a_id).unwrap();
        assert_eq!(thread_a["unread"], 0);
    }

    #[test]
    fn manual_ordering() {
        let s = store();
        let a = s.create_group("Alpha", "", None);
        let b = s.create_group("Beta", "", None);
        let (aid, bid) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());
        // Creation order is preserved (position auto-increments).
        let names: Vec<String> = s.list_groups().iter().map(|g| g["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, vec!["Alpha", "Beta"]);
        s.reorder_groups(&[bid.to_string(), aid.to_string()]);
        let names: Vec<String> = s.list_groups().iter().map(|g| g["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, vec!["Beta", "Alpha"]);
        let c1 = s.create_channel(aid, "zeta", "");
        let c2 = s.create_channel(aid, "acme", "");
        let (c1id, c2id) = (c1["id"].as_str().unwrap(), c2["id"].as_str().unwrap());
        let names: Vec<String> = s.group_channels(aid).iter().map(|c| c["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, vec!["zeta", "acme"]); // creation order, not alphabetical
        s.reorder_channels(aid, &[c2id.to_string(), c1id.to_string()]);
        let names: Vec<String> = s.group_channels(aid).iter().map(|c| c["name"].as_str().unwrap().into()).collect();
        assert_eq!(names, vec!["acme", "zeta"]);
    }

    #[test]
    fn update_channel_name_and_topic() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "old", "old topic");
        let cid = c["id"].as_str().unwrap();
        let updated = s.update_channel(cid, Some("new"), None, None).unwrap();
        assert_eq!(updated["name"], "new");
        assert_eq!(updated["topic"], "old topic");
        let updated = s.update_channel(cid, None, Some("fresh topic"), None).unwrap();
        assert_eq!(updated["name"], "new");
        assert_eq!(updated["topic"], "fresh topic");
    }

    #[test]
    fn hide_groups_and_channels() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        assert_eq!(s.group(gid).unwrap()["hidden"], false);
        assert_eq!(s.channel(cid).unwrap()["hidden"], false);
        let hidden = s.set_group_hidden(gid, true).unwrap();
        assert_eq!(hidden["hidden"], true);
        assert_eq!(s.list_groups()[0]["hidden"], true);
        assert_eq!(s.set_group_hidden(gid, false).unwrap()["hidden"], false);
        assert!(s.set_group_hidden("nope", true).is_none());
        let updated = s.update_channel(cid, None, None, Some(true)).unwrap();
        assert_eq!(updated["hidden"], true);
        assert_eq!(updated["name"], "main"); // untouched
        assert_eq!(s.group_channels(gid)[0]["hidden"], true);
        assert_eq!(s.update_channel(cid, None, None, Some(false)).unwrap()["hidden"], false);
    }

    #[test]
    fn thread_hide_and_unhide() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "mine", "user", "tom", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        s.add_message(cid, "re", "agent", "bot", None, Some(root_id), &[]);
        assert_eq!(s.my_threads("tom", 50).len(), 1);
        s.hide_thread("tom", root_id);
        s.hide_thread("tom", root_id); // idempotent
        assert!(s.my_threads("tom", 50).is_empty());
        // The messages themselves are untouched.
        assert_eq!(s.messages(cid, Some(root_id), None, 50).len(), 1);
        assert!(s.unhide_thread("tom", root_id));
        assert!(!s.unhide_thread("tom", root_id));
        assert_eq!(s.my_threads("tom", 50).len(), 1);
        // Channel delete sweeps hide rows too.
        s.hide_thread("tom", root_id);
        s.delete_channel(cid);
        let conn_count: i64 = {
            let conn = s.conn.lock().unwrap();
            conn.query_row("SELECT COUNT(*) FROM thread_hides", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(conn_count, 0);
    }

    #[test]
    fn mentions_cascade_with_channel_delete() {
        let s = store();
        let g = s.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let root = s.add_message(cid, "root @tom", "agent", "bot", None, None, &[]);
        let root_id = root["id"].as_i64().unwrap();
        s.add_mentions(root_id, cid, &["tom".to_string()]);
        s.mark_thread_read("tom", root_id, Some(5));
        s.delete_channel(cid);
        // Fresh channel with the same id space: no leftover state.
        let u = s.unread_counts("tom", &[cid.to_string()]);
        assert!(u[cid].is_null() || u[cid]["mentions"] == 0);
        assert!(s.my_threads("tom", 50).is_empty());
    }

    #[test]
    fn pins_and_stars() {
        let s = store();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let m = s.add_message(cid, "root", "user", "tom", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();
        assert!(s.pin_message(cid, mid, Some("tom")));
        assert!(!s.pin_message(cid, mid, Some("tom"))); // idempotent
        assert_eq!(s.pin_count(cid), 1);
        assert_eq!(s.channel_pins(cid)[0]["id"], mid);
        assert!(s.unpin_message(cid, mid));
        assert!(s.star_message("tom", cid, mid));
        assert_eq!(s.user_stars("tom", cid).len(), 1);
        assert!(s.unstar_message("tom", mid));
        assert!(s.user_stars("tom", cid).is_empty());
    }

    #[test]
    fn attachments_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("agora.db")).unwrap();
        let g = s.create_group("G", "", None);
        let gid = g["id"].as_str().unwrap();
        let c = s.create_channel(gid, "main", "");
        let cid = c["id"].as_str().unwrap();
        let att = NewAttachment {
            filename: "note.txt".into(),
            mime: "text/plain".into(),
            data: b"hello bytes".to_vec(),
        };
        let m = s.add_message(cid, "with file", "user", "tom", None, None, &[att]);
        let file_id = m["attachments"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(std::fs::read(s.file_path(&file_id)).unwrap(), b"hello bytes");
        let fetched = s.message(m["id"].as_i64().unwrap()).unwrap();
        assert_eq!(fetched["attachments"][0]["filename"], "note.txt");
        // Channel delete unlinks bytes.
        s.delete_channel(cid);
        assert!(!s.file_path(&file_id).exists());
    }

    #[test]
    fn agents_registry() {
        let s = store();
        s.upsert_agent("mimir", "Mimir", "pantheo-local", false, false, 0);
        s.upsert_agent("mimir", "Mimir 2", "pantheo-local", true, true, 1234);
        let agents = s.known_agents();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["name"], "Mimir 2");
        assert_eq!(agents[0]["requires_mention"], true);
        assert_eq!(agents[0]["has_avatar"], true);
        assert_eq!(agents[0]["avatar_v"], 1234);
        assert!(s.remove_agent("mimir"));
        assert!(s.known_agents().is_empty());
    }
}
