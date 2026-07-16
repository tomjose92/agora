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
}

impl DesktopSettings {
    /// The remote UI URL with the token attached, when fully configured.
    pub fn remote_url(&self) -> Option<String> {
        let url = self.url.as_deref()?.trim_end_matches('/').to_string();
        let token = self.token.as_deref()?;
        (!url.is_empty() && !token.is_empty()).then(|| format!("{url}/?token={token}"))
    }
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
