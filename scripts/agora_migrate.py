#!/usr/bin/env python3
"""Move an Agora's data (groups, channels, messages, attachments) between
instances — any combination of local data dirs and live servers.

  # laptop desktop app -> hosted Railway deployment
  scripts/agora_migrate.py \
      --from "~/Library/Application Support/app.agora.desktop" \
      --to https://agora.up.railway.app --to-token ADMINKEY

  # hosted -> hosted (replace whatever the target has)
  scripts/agora_migrate.py \
      --from https://old.example.com  --from-token AAA \
      --to   https://new.example.com  --to-token BBB   --replace

  # hosted -> local dir (staged; applied next time that Agora boots)
  scripts/agora_migrate.py \
      --from https://agora.up.railway.app --from-token AAA \
      --to "~/Library/Application Support/app.agora.desktop" --replace

Sources/targets starting with http(s):// are live servers (admin key
required); anything else is a data dir on this machine. Tokens and bind
settings never migrate — each instance keeps its own config.json.

Local *source* dirs are snapshotted with SQLite's backup API, so a running
app is safe (though quitting it first is tidier). Local *targets* get the
archive staged as import-staged.tar.gz, applied the next time that Agora
starts. Server targets restart themselves to apply the import; the script
waits for them to come back.
"""

from __future__ import annotations

import argparse
import io
import json
import sqlite3
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

FORMAT_VERSION = 1
STAGED_NAME = "import-staged.tar.gz"


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def is_url(target: str) -> bool:
    return target.startswith("http://") or target.startswith("https://")


def api(url: str, token: str, path: str, data: bytes | None = None,
        content_type: str | None = None, timeout: int = 300) -> bytes:
    request = urllib.request.Request(url.rstrip("/") + path, data=data)
    request.add_header("Authorization", f"Bearer {token}")
    if content_type:
        request.add_header("Content-Type", content_type)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


# ------------------------------------------------------------------- export

def export_from_url(url: str, token: str) -> bytes:
    print(f"==> Exporting from {url}")
    return api(url, token, "/api/export")


def export_from_dir(data_dir: Path) -> bytes:
    db = data_dir / "agora.db"
    if not db.exists():
        die(f"no agora.db in {data_dir} — is that an Agora data dir?")
    print(f"==> Exporting from {data_dir}")

    # Consistent snapshot via SQLite's backup API, safe if the app is running.
    tmp = data_dir / f".export-{uuid.uuid4().hex}.db"
    src = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(tmp)
        src.backup(dst)
        dst.close()
    finally:
        src.close()

    counts = {}
    conn = sqlite3.connect(tmp)
    try:
        for table in ("groups", "channels", "messages", "files"):
            counts[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    finally:
        conn.close()

    config = {}
    config_path = data_dir / "config.json"
    if config_path.exists():
        config = json.loads(config_path.read_text())
    manifest = {
        "format": FORMAT_VERSION,
        "instance_id": config.get("instance_id", ""),
        "instance_name": config.get("instance_name", ""),
        "exported_at": time.time(),
        "counts": counts,
    }

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        manifest_bytes = json.dumps(manifest, indent=2).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(manifest_bytes)
        tar.addfile(info, io.BytesIO(manifest_bytes))
        tar.add(tmp, arcname="agora.db")
        files_dir = data_dir / "agora_files"
        if files_dir.is_dir():
            tar.add(files_dir, arcname="agora_files")
    tmp.unlink()
    print(f"    {counts['groups']} groups, {counts['channels']} channels, "
          f"{counts['messages']} messages, {counts['files']} files")
    return buffer.getvalue()


# ------------------------------------------------------------------- import

def import_to_url(url: str, token: str, archive: bytes, replace: bool) -> None:
    print(f"==> Importing to {url}" + (" (replace)" if replace else ""))
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="archive"; filename="export.tar.gz"\r\n'
        f"Content-Type: application/gzip\r\n\r\n"
    ).encode() + archive + f"\r\n--{boundary}--\r\n".encode()
    path = "/api/import" + ("?replace=true" if replace else "")
    try:
        response = api(url, token, path, data=body,
                       content_type=f"multipart/form-data; boundary={boundary}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        die(f"import rejected ({e.code}): {detail}")
    print(f"    {json.loads(response).get('detail', 'staged')}")

    print("==> Waiting for the server to restart and apply it", end="", flush=True)
    deadline = time.time() + 120
    time.sleep(3)
    while time.time() < deadline:
        try:
            api(url, token, "/api/me", timeout=5)
            print(" — back up.")
            return
        except Exception:
            print(".", end="", flush=True)
            time.sleep(2)
    print()
    die("server did not come back within 120s; check its logs")


def import_to_dir(data_dir: Path, archive: bytes, replace: bool) -> None:
    if (data_dir / "agora.db").exists() and not replace:
        die(f"{data_dir} already has an agora.db; pass --replace to overwrite it "
            "(the old data is kept in a pre-import-<ts>/ backup)")
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / STAGED_NAME).write_bytes(archive)
    print(f"==> Staged into {data_dir / STAGED_NAME}")
    print("    It will be applied the next time this Agora starts "
          "(the previous data is kept in a pre-import-<ts>/ backup).")


# --------------------------------------------------------------------- main

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="source", required=True,
                        help="source: data dir or http(s) URL")
    parser.add_argument("--to", dest="target",
                        help="target: data dir or http(s) URL (optional with --save)")
    parser.add_argument("--from-token", default="", help="admin key (URL source)")
    parser.add_argument("--to-token", default="", help="admin key (URL target)")
    parser.add_argument("--replace", action="store_true",
                        help="overwrite a target that already has data")
    parser.add_argument("--save", metavar="FILE",
                        help="also write the export archive to FILE (backup)")
    args = parser.parse_args()
    if not args.target and not args.save:
        die("nothing to do: pass --to and/or --save")

    if is_url(args.source):
        if not args.from_token:
            die("--from-token is required for a URL source")
        archive = export_from_url(args.source, args.from_token)
    else:
        archive = export_from_dir(Path(args.source).expanduser())

    if args.save:
        Path(args.save).write_bytes(archive)
        print(f"==> Saved archive to {args.save} ({len(archive)} bytes)")

    if args.target:
        if is_url(args.target):
            if not args.to_token:
                die("--to-token is required for a URL target")
            import_to_url(args.target, args.to_token, archive, args.replace)
        else:
            import_to_dir(Path(args.target).expanduser(), archive, args.replace)

    print("==> Done.")


if __name__ == "__main__":
    main()
