//! App configuration persisted as `config.json` in the data dir.
//!
//! The owner token authenticates the (single) local user's UI/API calls; it
//! is generated on first run. Pairing tokens authenticate dial-in agent
//! bridges. Connections are the Pantheo (or compatible) endpoints the app
//! dials out to.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::store::new_token;

#[derive(Clone, Serialize, Deserialize)]
pub struct Connection {
    pub name: String,
    /// ws(s)://host:port/agora/connect
    pub url: String,
    pub token: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PairingToken {
    pub token: String,
    pub name: String,
    pub created_at: f64,
}

fn default_true() -> bool {
    true
}

fn default_username() -> String {
    "me".to_string()
}

fn default_instance_name() -> String {
    "My Agora".to_string()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ConfigData {
    #[serde(default)]
    pub owner_token: String,
    /// Stable identity this app declares to every linked Pantheo (an
    /// `identify` frame after connect), so an instance serving several Agoras
    /// can keep their sessions and channels apart. Generated once, kept for
    /// the life of the data dir.
    #[serde(default)]
    pub instance_id: String,
    /// Human-readable name shown alongside this app's chats on the other side.
    #[serde(default = "default_instance_name")]
    pub instance_name: String,
    #[serde(default = "default_username")]
    pub username: String,
    /// Loopback by default; set 0.0.0.0 to accept LAN bridges.
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub pairing_tokens: Vec<PairingToken>,
    /// Per-attachment upload cap, megabytes.
    #[serde(default = "default_max_file_mb")]
    pub max_file_mb: u64,
}

fn default_bind() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    4470
}

fn default_max_file_mb() -> u64 {
    10
}

impl Default for ConfigData {
    fn default() -> Self {
        Self {
            owner_token: new_token(),
            instance_id: new_token(),
            instance_name: default_instance_name(),
            username: default_username(),
            bind: default_bind(),
            port: default_port(),
            connections: Vec::new(),
            pairing_tokens: Vec::new(),
            max_file_mb: default_max_file_mb(),
        }
    }
}

pub struct Config {
    path: PathBuf,
    data: Mutex<ConfigData>,
}

impl Config {
    pub fn load(data_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("config.json");
        let mut data: ConfigData = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => ConfigData::default(),
        };
        if data.owner_token.is_empty() {
            data.owner_token = new_token();
        }
        if data.instance_id.is_empty() {
            data.instance_id = new_token();
        }
        if data.instance_name.trim().is_empty() {
            data.instance_name = default_instance_name();
        }
        let cfg = Self {
            path,
            data: Mutex::new(data),
        };
        cfg.save();
        Ok(cfg)
    }

    pub fn snapshot(&self) -> ConfigData {
        self.data.lock().unwrap().clone()
    }

    pub fn owner_token(&self) -> String {
        self.data.lock().unwrap().owner_token.clone()
    }

    pub fn username(&self) -> String {
        self.data.lock().unwrap().username.clone()
    }

    pub fn instance_id(&self) -> String {
        self.data.lock().unwrap().instance_id.clone()
    }

    pub fn instance_name(&self) -> String {
        self.data.lock().unwrap().instance_name.clone()
    }

    pub fn update<F: FnOnce(&mut ConfigData)>(&self, f: F) {
        {
            let mut data = self.data.lock().unwrap();
            f(&mut data);
        }
        self.save();
    }

    pub fn valid_pairing_token(&self, token: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        data.pairing_tokens
            .iter()
            .find(|t| constant_time_eq(&t.token, token))
            .map(|t| t.name.clone())
    }

    pub fn is_owner_token(&self, token: &str) -> bool {
        constant_time_eq(&self.data.lock().unwrap().owner_token, token)
    }

    fn save(&self) {
        let data = self.data.lock().unwrap();
        if let Ok(text) = serde_json::to_string_pretty(&*data) {
            std::fs::write(&self.path, text).ok();
        }
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_identity_is_generated_once_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let id = cfg.instance_id();
        assert_eq!(id.len(), 32); // 16 random bytes, hex
        assert_eq!(cfg.instance_name(), "My Agora");
        cfg.update(|c| c.instance_name = "Home Agora".into());
        drop(cfg);
        // A reload keeps both the generated id and the chosen name.
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.instance_id(), id);
        assert_eq!(cfg.instance_name(), "Home Agora");
    }

    #[test]
    fn legacy_config_without_identity_gets_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"owner_token": "aaaa", "username": "tom"}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert!(!cfg.instance_id().is_empty());
        assert_eq!(cfg.instance_name(), "My Agora");
        assert_eq!(cfg.username(), "tom");
    }
}
