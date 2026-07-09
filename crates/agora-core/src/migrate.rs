//! Move an Agora between machines: export the data dir as a tar.gz, stage an
//! import, apply it at boot.
//!
//! The archive carries `manifest.json` + `agora.db` + `agora_files/` — never
//! `config.json`, so tokens and bind settings stay with each instance. Imports
//! are staged (written next to the db) and applied on the next boot, because
//! swapping a live SQLite store under the hub isn't safe; the import endpoint
//! triggers a restart after staging. `AGORA_IMPORT_URL` seeds a *fresh* data
//! dir (no `agora.db` yet) from a remote export — the "new Railway volume,
//! old laptop data" path.

use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};

use crate::store::{now, Store};

/// Staged archive filename, inside the data dir.
pub const STAGED_NAME: &str = "import-staged.tar.gz";
/// Bump when the archive layout changes incompatibly.
pub const FORMAT_VERSION: u64 = 1;

/// Build an export archive of the given store (db snapshot + files + manifest).
pub fn export_archive(store: &Store, instance_id: &str, instance_name: &str) -> anyhow::Result<Vec<u8>> {
    let tmp_db = std::env::temp_dir().join(format!("agora-export-{}.db", crate::store::new_token()));
    store.backup_to(&tmp_db)?;
    let result = (|| {
        let manifest = json!({
            "format": FORMAT_VERSION,
            "instance_id": instance_id,
            "instance_name": instance_name,
            "exported_at": now(),
            "counts": store.counts(),
        });
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        {
            let mut tar = tar::Builder::new(&mut enc);
            append_bytes(&mut tar, "manifest.json", &serde_json::to_vec_pretty(&manifest)?)?;
            tar.append_path_with_name(&tmp_db, "agora.db")?;
            if store.files_dir.is_dir() {
                tar.append_dir_all("agora_files", &store.files_dir)?;
            }
            tar.finish()?;
        }
        Ok(enc.finish()?)
    })();
    std::fs::remove_file(&tmp_db).ok();
    result
}

fn append_bytes<W: std::io::Write>(tar: &mut tar::Builder<W>, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, name, bytes)?;
    Ok(())
}

/// Parse and sanity-check an archive; returns its manifest.
pub fn inspect_archive(bytes: &[u8]) -> anyhow::Result<Value> {
    let mut ar = tar::Archive::new(GzDecoder::new(bytes));
    let mut manifest: Option<Value> = None;
    let mut has_db = false;
    for entry in ar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_string_lossy().to_string();
        match path.as_str() {
            "manifest.json" => {
                let mut text = String::new();
                std::io::Read::read_to_string(&mut entry, &mut text)?;
                manifest = Some(serde_json::from_str(&text)?);
            }
            "agora.db" => has_db = true,
            _ => {}
        }
    }
    let manifest = manifest
        .ok_or_else(|| anyhow::anyhow!("archive has no manifest.json — not an Agora export"))?;
    let format = manifest["format"].as_u64().unwrap_or(0);
    anyhow::ensure!(
        format == FORMAT_VERSION,
        "unsupported archive format {format} (this build reads {FORMAT_VERSION})"
    );
    anyhow::ensure!(has_db, "archive has no agora.db");
    Ok(manifest)
}

/// Validate + write the archive next to the db, to be applied on next boot.
pub fn stage_import(data_dir: &Path, bytes: &[u8]) -> anyhow::Result<Value> {
    let manifest = inspect_archive(bytes)?;
    std::fs::write(data_dir.join(STAGED_NAME), bytes)?;
    Ok(manifest)
}

/// Apply a staged import if one exists. Called at boot, before the store is
/// opened. The current db/files are moved to `pre-import-<ts>/` first, so a
/// bad import is recoverable by hand.
pub fn apply_staged_import(data_dir: &Path) -> anyhow::Result<bool> {
    let staged = data_dir.join(STAGED_NAME);
    if !staged.exists() {
        return Ok(false);
    }
    let bytes = std::fs::read(&staged)?;
    if let Err(e) = inspect_archive(&bytes) {
        // Junk on disk must not brick every subsequent boot.
        std::fs::remove_file(&staged).ok();
        anyhow::bail!("staged import is invalid, removed it: {e}");
    }

    let backup = data_dir.join(format!("pre-import-{}", now() as u64));
    std::fs::create_dir_all(&backup)?;
    for name in ["agora.db", "agora.db-wal", "agora.db-shm"] {
        let src = data_dir.join(name);
        if src.exists() {
            std::fs::rename(&src, backup.join(name))?;
        }
    }
    let files_dir = data_dir.join("agora_files");
    if files_dir.exists() {
        std::fs::rename(&files_dir, backup.join("agora_files"))?;
    }

    let mut ar = tar::Archive::new(GzDecoder::new(&bytes[..]));
    for entry in ar.entries()? {
        let mut entry = entry?;
        // unpack_in refuses absolute paths and `..` escapes.
        entry.unpack_in(data_dir)?;
    }
    std::fs::remove_file(&staged)?;
    tracing::info!("applied staged import (previous data in {})", backup.display());
    Ok(true)
}

/// Seed a *fresh* data dir (no agora.db yet) from `AGORA_IMPORT_URL`.
pub fn seed_from_env(data_dir: &Path) -> anyhow::Result<()> {
    let Some(url) = std::env::var("AGORA_IMPORT_URL").ok().filter(|v| !v.is_empty()) else {
        return Ok(());
    };
    if data_dir.join("agora.db").exists() {
        tracing::info!("AGORA_IMPORT_URL set but agora.db already exists; skipping seed");
        return Ok(());
    }
    tracing::info!("seeding data dir from {url}");
    let response = ureq::get(&url).timeout(std::time::Duration::from_secs(300)).call()?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut response.into_reader(), &mut bytes)?;
    std::fs::create_dir_all(data_dir)?;
    stage_import(data_dir, &bytes)?;
    apply_staged_import(data_dir)?;
    Ok(())
}

/// Where a staged archive would live for the given data dir.
pub fn staged_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STAGED_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::NewAttachment;

    fn seeded_store(dir: &Path) -> Store {
        let store = Store::open(&dir.join("agora.db")).unwrap();
        let group = store.create_group("Home", "test group", Some("me"));
        let channel = store.create_channel(group["id"].as_str().unwrap(), "general", "");
        store.add_message(
            channel["id"].as_str().unwrap(),
            "hello from the old world",
            "user",
            "me",
            Some("me"),
            None,
            &[NewAttachment {
                filename: "note.txt".into(),
                mime: "text/plain".into(),
                data: b"attachment bytes".to_vec(),
            }],
        );
        store
    }

    #[test]
    fn export_import_round_trip() {
        let src = tempfile::tempdir().unwrap();
        let store = seeded_store(src.path());
        let archive = export_archive(&store, "src-id", "Source Agora").unwrap();

        let manifest = inspect_archive(&archive).unwrap();
        assert_eq!(manifest["counts"]["groups"], 1);
        assert_eq!(manifest["counts"]["messages"], 1);
        assert_eq!(manifest["counts"]["files"], 1);

        let dst = tempfile::tempdir().unwrap();
        stage_import(dst.path(), &archive).unwrap();
        assert!(apply_staged_import(dst.path()).unwrap());
        assert!(!staged_path(dst.path()).exists(), "staged file consumed");

        let imported = Store::open(&dst.path().join("agora.db")).unwrap();
        let groups = imported.list_groups();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["name"], "Home");
        assert_eq!(imported.counts()["messages"], 1);
        // Attachment bytes came along.
        let files: Vec<_> = std::fs::read_dir(dst.path().join("agora_files"))
            .unwrap()
            .collect();
        assert_eq!(files.len(), 1);
    }

    #[test]
    fn apply_backs_up_existing_data() {
        let src = tempfile::tempdir().unwrap();
        let archive = export_archive(&seeded_store(src.path()), "a", "A").unwrap();

        let dst = tempfile::tempdir().unwrap();
        let old = seeded_store(dst.path());
        old.create_group("Doomed", "will be replaced", None);
        drop(old);
        stage_import(dst.path(), &archive).unwrap();
        assert!(apply_staged_import(dst.path()).unwrap());

        let imported = Store::open(&dst.path().join("agora.db")).unwrap();
        assert_eq!(imported.list_groups().len(), 1, "replaced, not merged");
        let backup = std::fs::read_dir(dst.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .find(|e| e.file_name().to_string_lossy().starts_with("pre-import-"));
        assert!(backup.is_some(), "old data preserved in pre-import dir");
    }

    #[test]
    fn junk_archives_are_rejected_and_cleared() {
        assert!(inspect_archive(b"not a tarball").is_err());

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(staged_path(dir.path()), b"garbage").unwrap();
        assert!(apply_staged_import(dir.path()).is_err());
        assert!(!staged_path(dir.path()).exists(), "junk cleared so boot recovers");
        // Second boot proceeds normally.
        assert!(!apply_staged_import(dir.path()).unwrap());
    }

    #[test]
    fn no_staged_import_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!apply_staged_import(dir.path()).unwrap());
    }
}
