//! Desktop-shell settings (`desktop.json` in the app data dir): which server
//! this window fronts. Deliberately separate from the core's `config.json` —
//! that file belongs to the embedded server, this one to the shell.

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Embedded,
    Remote,
}

/// How many previously joined servers to keep around.
const RECENT_CAP: usize = 8;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DesktopSettings {
    #[serde(default)]
    pub mode: Mode,
    /// Remote server base URL, e.g. https://agora.up.railway.app
    #[serde(default)]
    pub url: Option<String>,
    /// Admin key of the remote server.
    #[serde(default)]
    pub token: Option<String>,
    /// Previously joined remote servers, most recent first. URLs only —
    /// never credentials. Owned by the Rust side: commands re-merge this
    /// from disk so a webview payload can't clobber the history.
    #[serde(default)]
    pub recent: Vec<String>,
}

impl DesktopSettings {
    /// The remote UI URL with the token attached, when fully configured.
    pub fn remote_url(&self) -> Option<String> {
        let url = self.url.as_deref()?.trim_end_matches('/').to_string();
        let token = self.token.as_deref()?;
        (!url.is_empty() && !token.is_empty()).then(|| format!("{url}/?token={token}"))
    }

    /// Record a successful connection: move the URL to the front of the
    /// recent list (deduped, capped).
    pub fn remember(&mut self, url: &str) {
        let url = normalize(url);
        if url.is_empty() {
            return;
        }
        self.recent.retain(|u| u != &url);
        self.recent.insert(0, url);
        self.recent.truncate(RECENT_CAP);
    }

    /// Drop a URL from the recent list (user removed it).
    pub fn forget(&mut self, url: &str) {
        let url = normalize(url);
        self.recent.retain(|u| u != &url);
    }
}

fn normalize(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

pub fn load(data_dir: &Path) -> DesktopSettings {
    std::fs::read_to_string(data_dir.join("desktop.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(data_dir: &Path, settings: &DesktopSettings) -> anyhow::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let text = serde_json::to_string_pretty(settings)?;
    std::fs::write(data_dir.join("desktop.json"), text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remember_dedupes_and_fronts() {
        let mut s = DesktopSettings::default();
        s.remember("https://a.example");
        s.remember("https://b.example/");
        s.remember(" https://a.example ");
        assert_eq!(s.recent, vec!["https://a.example", "https://b.example"]);
    }

    #[test]
    fn remember_caps_at_eight() {
        let mut s = DesktopSettings::default();
        for i in 0..12 {
            s.remember(&format!("https://s{i}.example"));
        }
        assert_eq!(s.recent.len(), 8);
        assert_eq!(s.recent[0], "https://s11.example");
        assert_eq!(s.recent[7], "https://s4.example");
    }

    #[test]
    fn remember_ignores_empty() {
        let mut s = DesktopSettings::default();
        s.remember("  ");
        assert!(s.recent.is_empty());
    }

    #[test]
    fn forget_removes_normalized() {
        let mut s = DesktopSettings::default();
        s.remember("https://a.example");
        s.remember("https://b.example");
        s.forget("https://a.example/");
        assert_eq!(s.recent, vec!["https://b.example"]);
    }

    #[test]
    fn roundtrip_preserves_recent_and_old_files_load() {
        let dir = std::env::temp_dir().join(format!("agora-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = DesktopSettings {
            mode: Mode::Remote,
            url: Some("https://a.example".into()),
            token: Some("k".into()),
            recent: vec![],
        };
        s.remember("https://a.example");
        save(&dir, &s).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.recent, vec!["https://a.example"]);
        // A pre-`recent` desktop.json still deserializes (serde default).
        std::fs::write(
            dir.join("desktop.json"),
            r#"{"mode":"remote","url":"https://a.example","token":"k"}"#,
        )
        .unwrap();
        assert!(load(&dir).recent.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
