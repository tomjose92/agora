//! Outbound connections: the app dials a Pantheo (or protocol-compatible)
//! endpoint's `/agora/connect` websocket, receives a `hello` frame listing
//! the agents that instance offers, registers them with the hub, and then
//! relays protocol frames in both directions until the socket drops —
//! after which it reconnects with backoff.
//!
//! Dialing *out* is what lets the app reach remotely deployed agents from
//! behind NAT, and is the only direction a future mobile build can use.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc::unbounded_channel;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Config;
use crate::hub::{AgentHandle, Hub};

#[derive(Clone, serde::Serialize)]
pub struct ConnStatus {
    pub name: String,
    pub url: String,
    pub connected: bool,
    pub agents: Vec<Value>,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct ManagerState {
    /// connection name -> abort handle for its run loop
    tasks: HashMap<String, tokio::task::AbortHandle>,
    status: HashMap<String, ConnStatus>,
}

pub struct ConnectionManager {
    hub: Arc<Hub>,
    config: Arc<Config>,
    state: Mutex<ManagerState>,
}

impl ConnectionManager {
    pub fn new(hub: Arc<Hub>, config: Arc<Config>) -> Arc<Self> {
        Arc::new(Self {
            hub,
            config,
            state: Mutex::new(ManagerState::default()),
        })
    }

    /// (Re)start run loops so they match the configured connection list.
    pub fn sync(self: &Arc<Self>) {
        let conns = self.config.snapshot().connections;
        let mut st = self.state.lock().unwrap();
        let wanted: Vec<String> = conns
            .iter()
            .filter(|c| c.enabled)
            .map(|c| c.name.clone())
            .collect();
        // Drop loops for removed/disabled connections.
        let stale: Vec<String> = st.tasks.keys().filter(|n| !wanted.contains(n)).cloned().collect();
        for name in stale {
            if let Some(handle) = st.tasks.remove(&name) {
                handle.abort();
            }
            st.status.remove(&name);
        }
        // Start loops for new ones.
        for conn in conns.into_iter().filter(|c| c.enabled) {
            if st.tasks.contains_key(&conn.name) {
                continue;
            }
            st.status.insert(
                conn.name.clone(),
                ConnStatus {
                    name: conn.name.clone(),
                    url: conn.url.clone(),
                    connected: false,
                    agents: Vec::new(),
                    last_error: None,
                },
            );
            let mgr = Arc::clone(self);
            let conn_name = conn.name.clone();
            let task = tokio::spawn(async move {
                mgr.run_loop(conn.name, conn.url, conn.token).await;
            });
            st.tasks.insert(conn_name, task.abort_handle());
        }
    }

    /// Drop every run loop and dial again — used when the app's declared
    /// identity changes so each endpoint re-learns it via a fresh `identify`.
    pub fn restart(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().unwrap();
            for (_, handle) in st.tasks.drain() {
                handle.abort();
            }
            st.status.clear();
        }
        self.sync();
    }

    pub fn status(&self) -> Vec<ConnStatus> {
        self.state.lock().unwrap().status.values().cloned().collect()
    }

    fn set_status<F: FnOnce(&mut ConnStatus)>(&self, name: &str, f: F) {
        let mut st = self.state.lock().unwrap();
        if let Some(s) = st.status.get_mut(name) {
            f(s);
        }
    }

    async fn run_loop(self: Arc<Self>, name: String, url: String, token: String) {
        let mut backoff = Duration::from_secs(1);
        loop {
            match self.run_once(&name, &url, &token).await {
                Ok(()) => {
                    backoff = Duration::from_secs(1);
                    self.set_status(&name, |s| {
                        s.connected = false;
                        s.last_error = Some("disconnected".into());
                    });
                }
                Err(e) => {
                    self.set_status(&name, |s| {
                        s.connected = false;
                        s.last_error = Some(e.to_string());
                    });
                    tracing::debug!("connection {name}: {e}");
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    }

    async fn run_once(&self, name: &str, url: &str, token: &str) -> anyhow::Result<()> {
        let sep = if url.contains('?') { '&' } else { '?' };
        let full = format!("{url}{sep}token={token}");
        let (ws, _) = connect_async(&full).await?;
        let (mut sink, mut stream) = ws.split();

        // The other side speaks first: hello with its agent roster.
        let hello = loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => {
                    let v: Value = serde_json::from_str(&text)?;
                    if v["type"] == "hello" {
                        break v;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(e.into()),
                None => anyhow::bail!("closed before hello"),
            }
        };

        // Declare who we are before any traffic: the other side uses this
        // stable id + display name to keep this app's chats apart from other
        // connected Agoras (sessions, bindings, targeted delivery).
        let ident = json!({
            "type": "identify",
            "agora_id": self.config.instance_id(),
            "agora_name": self.config.instance_name(),
        });
        sink.send(Message::Text(ident.to_string().into())).await?;

        let conn_id = self.hub.next_conn_id();
        let (tx, mut rx) = unbounded_channel::<Value>();
        let agents = hello["agents"].as_array().cloned().unwrap_or_default();
        for a in &agents {
            let Some(id) = a["id"].as_str() else { continue };
            self.hub.register_agent(AgentHandle {
                agent_id: id.to_string(),
                agent_name: a["name"].as_str().unwrap_or(id).to_string(),
                requires_mention: a["requires_mention"].as_bool().unwrap_or(false),
                source: name.to_string(),
                conn_id,
                tx: tx.clone(),
            });
        }
        self.set_status(name, |s| {
            s.connected = true;
            s.agents = agents.clone();
            s.last_error = None;
        });
        tracing::info!("connection {name}: linked, {} agent(s)", agents.len());

        // Pump: hub -> socket (inbound frames for the agents) and
        // socket -> hub (post/typing/progress), plus keepalive pings.
        let mut ping = tokio::time::interval(Duration::from_secs(30));
        let result = loop {
            tokio::select! {
                out = rx.recv() => {
                    match out {
                        Some(frame) => {
                            sink.send(Message::Text(frame.to_string().into())).await?;
                        }
                        None => break Ok(()),
                    }
                }
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                                if frame["type"] == "hello" {
                                    // Roster refresh mid-connection.
                                    for a in frame["agents"].as_array().cloned().unwrap_or_default() {
                                        let Some(id) = a["id"].as_str() else { continue };
                                        self.hub.register_agent(AgentHandle {
                                            agent_id: id.to_string(),
                                            agent_name: a["name"].as_str().unwrap_or(id).to_string(),
                                            requires_mention: a["requires_mention"].as_bool().unwrap_or(false),
                                            source: name.to_string(),
                                            conn_id,
                                            tx: tx.clone(),
                                        });
                                    }
                                } else {
                                    self.hub.handle_agent_frame(&frame);
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break Ok(()),
                        Some(Ok(_)) => {}
                        Some(Err(e)) => break Err(e.into()),
                    }
                }
                _ = ping.tick() => {
                    sink.send(Message::Ping(Vec::new().into())).await?;
                }
            }
        };
        self.hub.unregister_connection(conn_id);
        self.set_status(name, |s| {
            s.connected = false;
            s.agents = Vec::new();
        });
        result
    }
}

/// Build the `hello` frame an Agora endpoint sends after accepting a
/// connection (used by tests and by the dial-in handler documentation).
pub fn hello_frame(agents: &[Value]) -> Value {
    json!({"type": "hello", "agents": agents})
}
