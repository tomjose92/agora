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
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
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
    ts REAL NOT NULL
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
    last_seen REAL NOT NULL
);
"#;

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

fn message_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, i64>(offset)?,
        "channel_id": row.get::<_, String>(offset + 1)?,
        "thread_id": row.get::<_, Option<i64>>(offset + 2)?,
        "author_type": row.get::<_, String>(offset + 3)?,
        "author_id": row.get::<_, String>(offset + 4)?,
        "author_name": row.get::<_, Option<String>>(offset + 5)?,
        "text": row.get::<_, String>(offset + 6)?,
        "ts": row.get::<_, f64>(offset + 7)?,
    }))
}

const MSG_COLS: &str = "id, channel_id, thread_id, author_type, author_id, author_name, text, ts";

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
        Ok(Self {
            conn: Mutex::new(conn),
            files_dir: path.parent().unwrap_or(Path::new(".")).join("agora_files"),
        })
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            files_dir: std::env::temp_dir().join("agora_files_test"),
        })
    }

    // ------------------------------------------------------------- groups

    pub fn create_group(&self, name: &str, description: &str, created_by: Option<&str>) -> Value {
        let gid = new_id(name);
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO groups (id, name, description, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
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
            "SELECT id, name, description, created_by, created_at FROM groups WHERE id = ?1",
            params![group_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                    "description": r.get::<_, String>(2)?,
                    "created_by": r.get::<_, Option<String>>(3)?,
                    "created_at": r.get::<_, f64>(4)?,
                }))
            },
        )
        .ok()
    }

    pub fn list_groups(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, description, created_by, created_at FROM groups ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                "description": r.get::<_, String>(2)?,
                "created_by": r.get::<_, Option<String>>(3)?,
                "created_at": r.get::<_, f64>(4)?,
            }))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
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
                for table in ["messages", "pins", "stars", "files", "reads"] {
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
                "INSERT INTO channels (id, group_id, name, topic, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![cid, group_id, name, topic, now()],
            )
            .unwrap();
        }
        self.channel(&cid).unwrap_or(Value::Null)
    }

    pub fn channel(&self, channel_id: &str) -> Option<Value> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, group_id, name, topic, created_at FROM channels WHERE id = ?1",
            params![channel_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "group_id": r.get::<_, String>(1)?,
                    "name": r.get::<_, String>(2)?, "topic": r.get::<_, String>(3)?,
                    "created_at": r.get::<_, f64>(4)?,
                }))
            },
        )
        .ok()
    }

    pub fn group_channels(&self, group_id: &str) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, group_id, name, topic, created_at FROM channels WHERE group_id = ?1 ORDER BY name",
            )
            .unwrap();
        stmt.query_map(params![group_id], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "group_id": r.get::<_, String>(1)?,
                "name": r.get::<_, String>(2)?, "topic": r.get::<_, String>(3)?,
                "created_at": r.get::<_, f64>(4)?,
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
            for table in ["messages", "memberships", "pins", "stars", "files", "reads"] {
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
        let ts = now();
        let mut stored_files = Vec::new();
        let message_id;
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO messages (channel_id, thread_id, author_type, author_id, author_name, text, ts) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![channel_id, thread_id, author_type, author_id, author_name, text, ts],
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
            "attachments": stored_files,
        })
    }

    pub fn message(&self, message_id: i64) -> Option<Value> {
        let msg = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                &format!("SELECT {MSG_COLS} FROM messages WHERE id = ?1"),
                params![message_id],
                |r| message_row(r, 0),
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
                     m.author_name, m.text, m.ts, s.starred_at, \
                     r.id, r.channel_id, r.thread_id, r.author_type, r.author_id, \
                     r.author_name, r.text, r.ts \
                     FROM stars s JOIN messages m ON m.id = s.message_id \
                     LEFT JOIN messages r ON r.id = m.thread_id \
                     WHERE s.username = ?1 AND s.channel_id = ?2 ORDER BY s.starred_at DESC",
                )
                .unwrap();
            stmt.query_map(params![username, channel_id], |r| {
                let mut star = message_row(r, 0)?;
                star["starred_at"] = json!(r.get::<_, f64>(8)?);
                star["root"] = match r.get::<_, Option<i64>>(9)? {
                    Some(_) => message_row(r, 9)?,
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

    /// Per-channel unread state: `{channel_id: {count, last_read_id}}`.
    /// Unread = messages newer than the marker, own messages excluded.
    pub fn unread_counts(&self, username: &str, channel_ids: &[String]) -> Value {
        if channel_ids.is_empty() {
            return json!({});
        }
        let placeholders = vec!["?"; channel_ids.len()].join(",");
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT c.id, COALESCE(r.last_read_id, 0), COUNT(m.id) \
                 FROM channels c \
                 LEFT JOIN reads r ON r.username = ?1 AND r.channel_id = c.id \
                 LEFT JOIN messages m ON m.channel_id = c.id \
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
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
            })
            .unwrap()
            .filter_map(Result::ok);
        for (cid, last_read, count) in rows {
            out.insert(cid, json!({"count": count, "last_read_id": last_read}));
        }
        Value::Object(out)
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
                     m.author_name, m.text, m.ts, p.pinned_by, p.pinned_at, \
                     (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id) \
                     FROM pins p JOIN messages m ON m.id = p.message_id \
                     WHERE p.channel_id = ?1 ORDER BY p.pinned_at DESC",
                )
                .unwrap();
            stmt.query_map(params![channel_id], |r| {
                let mut msg = message_row(r, 0)?;
                msg["pinned_by"] = json!(r.get::<_, Option<String>>(8)?);
                msg["pinned_at"] = json!(r.get::<_, f64>(9)?);
                msg["reply_count"] = json!(r.get::<_, i64>(10)?);
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
    pub fn upsert_agent(&self, id: &str, name: &str, source: &str, requires_mention: bool) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agents (id, name, source, requires_mention, last_seen) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, source = excluded.source, \
             requires_mention = excluded.requires_mention, last_seen = excluded.last_seen",
            params![id, name, source, requires_mention as i64, now()],
        )
        .unwrap();
    }

    pub fn known_agents(&self) -> Vec<Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, source, requires_mention, last_seen FROM agents ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
                "source": r.get::<_, String>(2)?,
                "requires_mention": r.get::<_, i64>(3)? != 0,
                "last_seen": r.get::<_, f64>(4)?,
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
        s.upsert_agent("mimir", "Mimir", "pantheo-local", false);
        s.upsert_agent("mimir", "Mimir 2", "pantheo-local", true);
        let agents = s.known_agents();
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0]["name"], "Mimir 2");
        assert_eq!(agents[0]["requires_mention"], true);
        assert!(s.remove_agent("mimir"));
        assert!(s.known_agents().is_empty());
    }
}
