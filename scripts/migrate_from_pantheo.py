#!/usr/bin/env python3
"""Migrate a Pantheo in-process Agora database into a standalone Agora app.

Before Agora became its own application, Pantheo hosted it in-process and kept
its state at ``data/agora.db`` (+ attachment bytes in ``data/agora_files/``).
The standalone app's schema is a faithful port of that store, so this script
copies everything across: groups, channels, memberships, messages (threads
intact), pins, stars, read markers, and attachments.

Usage — run with the app **stopped** (its SQLite connection must be closed):

    python3 scripts/migrate_from_pantheo.py \
        --old /path/to/pantheo/data/agora.db \
        --new "~/Library/Application Support/app.agora.desktop/agora.db" \
        [--map-user tom=me] [--dry-run]

Notes:
- The target db may already have content: message ids are offset past the
  target's current maximum and every reference (threads, pins, stars, reads,
  files) is remapped. Group/channel ids are copied verbatim (random slug-hex,
  collisions are ignored with a warning).
- ``--map-user`` renames a Pantheo username on the way in (stars, reads,
  memberships, message authorship). The standalone app is single-user, so you
  typically map your old Pantheo username to the app's ``username`` from its
  config.json (default "me"). Repeatable.
- Agent memberships are preserved and the agents registry is seeded from
  them, so channel rosters render before the agents reconnect. Agent ids are
  stable across the migration (they're the Pantheo agent ids either way).
- Re-running is guarded: if any migrated group id already exists in the
  target the script aborts unless ``--force`` is given.
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import time
from pathlib import Path

# Mirror of crates/agora-core/src/store.rs SCHEMA, so the target may be a
# fresh path (app not yet run). Idempotent on an existing db.
SCHEMA = """
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
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    requires_mention INTEGER NOT NULL DEFAULT 0,
    last_seen REAL NOT NULL
);
"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--old", required=True, help="Pantheo data/agora.db (source)")
    p.add_argument("--new", required=True, help="standalone app agora.db (target)")
    p.add_argument(
        "--map-user",
        action="append",
        default=[],
        metavar="OLD=NEW",
        help="rename a username on the way in (repeatable), e.g. tom=me",
    )
    p.add_argument("--dry-run", action="store_true", help="report what would happen, write nothing")
    p.add_argument("--force", action="store_true", help="proceed even if groups look already migrated")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    old_db = Path(args.old).expanduser()
    new_db = Path(args.new).expanduser()
    if not old_db.exists():
        print(f"error: source db not found: {old_db}", file=sys.stderr)
        return 1
    user_map: dict[str, str] = {}
    for pair in args.map_user:
        old_u, sep, new_u = pair.partition("=")
        if not sep or not old_u or not new_u:
            print(f"error: bad --map-user value: {pair!r} (want OLD=NEW)", file=sys.stderr)
            return 1
        user_map[old_u] = new_u
    mapped = lambda u: user_map.get(u, u)  # noqa: E731

    old_files = old_db.parent / "agora_files"
    new_files = new_db.parent / "agora_files"

    src = sqlite3.connect(f"file:{old_db}?mode=ro", uri=True)
    new_db.parent.mkdir(parents=True, exist_ok=True)
    dst = sqlite3.connect(new_db)
    dst.executescript(SCHEMA)

    # Guard against a duplicate run: the same group ids landing twice.
    old_group_ids = [r[0] for r in src.execute("SELECT id FROM groups")]
    if old_group_ids:
        marks = ",".join("?" * len(old_group_ids))
        already = dst.execute(
            f"SELECT COUNT(*) FROM groups WHERE id IN ({marks})", old_group_ids
        ).fetchone()[0]
        if already and not args.force:
            print(
                f"error: {already} of the source's {len(old_group_ids)} groups already exist "
                "in the target — was this migration already run? Use --force to override.",
                file=sys.stderr,
            )
            return 1

    # Messages keep their relative order but move past the target's max id;
    # every table referencing a message id gets the same shift.
    offset = dst.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()[0]
    counts: dict[str, int] = {}

    def bump(table: str, n: int = 1) -> None:
        counts[table] = counts.get(table, 0) + n

    dst.execute("BEGIN")

    for gid, name, desc, created_by, created_at in src.execute(
        "SELECT id, name, description, created_by, created_at FROM groups"
    ):
        cur = dst.execute(
            "INSERT OR IGNORE INTO groups (id, name, description, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (gid, name, desc, mapped(created_by) if created_by else created_by, created_at),
        )
        bump("groups", cur.rowcount)

    for cid, gid, name, topic, created_at in src.execute(
        "SELECT id, group_id, name, topic, created_at FROM channels"
    ):
        cur = dst.execute(
            "INSERT OR IGNORE INTO channels (id, group_id, name, topic, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (cid, gid, name, topic, created_at),
        )
        bump("channels", cur.rowcount)

    agent_ids: set[str] = set()
    for gid, cid, mtype, mid, role, added_at in src.execute(
        "SELECT group_id, channel_id, member_type, member_id, role, added_at FROM memberships"
    ):
        if mtype == "user":
            mid = mapped(mid)
        else:
            agent_ids.add(mid)
        cur = dst.execute(
            "INSERT OR IGNORE INTO memberships "
            "(group_id, channel_id, member_type, member_id, role, added_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (gid, cid, mtype, mid, role, added_at),
        )
        bump("memberships", cur.rowcount)

    # Seed the agents registry from memberships so channel rosters render
    # before the agents reconnect (a live `hello` refreshes name/mention flag).
    for aid in sorted(agent_ids):
        cur = dst.execute(
            "INSERT OR IGNORE INTO agents (id, name, source, requires_mention, last_seen) "
            "VALUES (?, ?, 'pantheo-migration', 0, ?)",
            (aid, aid, time.time()),
        )
        bump("agents", cur.rowcount)

    for mid, cid, tid, atype, aid, aname, text, ts in src.execute(
        "SELECT id, channel_id, thread_id, author_type, author_id, author_name, text, ts "
        "FROM messages ORDER BY id"
    ):
        if atype == "user":
            aid = mapped(aid)
        dst.execute(
            "INSERT INTO messages (id, channel_id, thread_id, author_type, author_id, "
            "author_name, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (mid + offset, cid, tid + offset if tid is not None else None, atype, aid, aname, text, ts),
        )
        bump("messages")

    for cid, mid, pinned_by, pinned_at in src.execute(
        "SELECT channel_id, message_id, pinned_by, pinned_at FROM pins"
    ):
        cur = dst.execute(
            "INSERT OR IGNORE INTO pins (channel_id, message_id, pinned_by, pinned_at) "
            "VALUES (?, ?, ?, ?)",
            (cid, mid + offset, mapped(pinned_by) if pinned_by else pinned_by, pinned_at),
        )
        bump("pins", cur.rowcount)

    for username, cid, mid, starred_at in src.execute(
        "SELECT username, channel_id, message_id, starred_at FROM stars"
    ):
        cur = dst.execute(
            "INSERT OR IGNORE INTO stars (username, channel_id, message_id, starred_at) "
            "VALUES (?, ?, ?, ?)",
            (mapped(username), cid, mid + offset, starred_at),
        )
        bump("stars", cur.rowcount)

    for username, cid, last_read, updated_at in src.execute(
        "SELECT username, channel_id, last_read_id, updated_at FROM reads"
    ):
        cur = dst.execute(
            "INSERT OR IGNORE INTO reads (username, channel_id, last_read_id, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (mapped(username), cid, last_read + offset if last_read else 0, updated_at),
        )
        bump("reads", cur.rowcount)

    missing_files: list[str] = []
    for fid, cid, mid, filename, mime, size, ts in src.execute(
        "SELECT id, channel_id, message_id, filename, mime, size, ts FROM files"
    ):
        cur = dst.execute(
            "INSERT OR IGNORE INTO files (id, channel_id, message_id, filename, mime, size, ts) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (fid, cid, mid + offset, filename, mime, size, ts),
        )
        bump("files", cur.rowcount)
        blob = old_files / fid
        if not blob.exists():
            missing_files.append(f"{fid} ({filename})")
        elif not args.dry_run and cur.rowcount:
            new_files.mkdir(parents=True, exist_ok=True)
            shutil.copy2(blob, new_files / fid)

    if args.dry_run:
        dst.rollback()
        print("dry run — nothing written. Would migrate:")
    else:
        dst.commit()
        print("migrated:")
    for table in ("groups", "channels", "memberships", "agents", "messages", "pins", "stars", "reads", "files"):
        print(f"  {table:12} {counts.get(table, 0)}")
    if offset:
        print(f"  (message ids shifted by +{offset} past the target's existing history)")
    if missing_files:
        print(f"warning: {len(missing_files)} attachment blob(s) missing on disk, metadata "
              f"migrated anyway: {', '.join(missing_files[:5])}"
              f"{' …' if len(missing_files) > 5 else ''}", file=sys.stderr)
    src.close()
    dst.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
