/* Connections overlay (#conn-panel) — the React port of ui/connections.js:
   instance name, linked Pantheo instances (4s status poll while open), and
   dial-in pairing tokens. Admin only. React-query's refetch keeps typed
   input intact (no innerHTML clobbering), so the vanilla focus guard isn't
   needed. */

import { useState } from "react";
import {
  useConnectionMutations, useConnectionsInfo, usePairingMutations, usePairingTokens,
  useRenameInstance,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

export function ConnectionsPane() {
  const ui = useUiState();
  const open = ui.panel === "connections";
  const info = useConnectionsInfo(open, open).data;
  const tokens = usePairingTokens(open).data || [];
  const connMut = useConnectionMutations();
  const pairMut = usePairingMutations();
  const [instName, setInstName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [pairName, setPairName] = useState("");
  const renameInstance = useRenameInstanceLocal();

  if (!open) return null;
  const conns = info?.connections || [];
  const instance = info?.instance || null;
  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  return (
    <div className="conn-overlay" id="conn-overlay"
      onClick={e => { if (e.target === e.currentTarget) ui.openPanel(null); }}>
      <div className="conn-panel" id="conn-panel">
        <div className="conn-head">
          <b>Connections</b>
          <button className="btn sm" onClick={() => ui.openPanel(null)}><Icon name="x" /></button>
        </div>
        <div className="conn-body">
          {instance && (
            <>
              <h4>This Agora <span className="dim">— how linked instances label this app's chats</span></h4>
              <div className="conn-add">
                <input id="inst-name" value={instName ?? (instance.name || "")}
                  placeholder="name (e.g. Home Agora)"
                  onChange={e => setInstName(e.target.value)} />
                <button className="btn sm primary" onClick={() => {
                  const v = (instName ?? instance.name ?? "").trim();
                  if (!v) { toast("Name required", { variant: "warn" }); return; }
                  renameInstance(v);
                  setInstName(null);
                }}>Rename</button>
              </div>
              <p className="conn-hint">Sessions and channel bindings on a linked Pantheo carry this name
                (instance id <code>{(instance.id || "").slice(0, 8)}</code>), so several Agoras stay distinct.</p>
            </>
          )}
          <h4>Pantheo instances <span className="dim">— the app dials out to them</span></h4>
          {conns.length ? conns.map(c => {
            const st = c.status;
            const agents = (st?.agents || []).map(a => a.name || a.id).join(", ");
            const detail = st?.connected
              ? (agents ? `agents: ${agents}` : "linked, no agents offered")
              : (st?.last_error ? String(st.last_error).slice(0, 120) : "connecting…");
            return (
              <div key={c.name} className="conn-row">
                <span className={`conn-dot ${st?.connected ? "on" : "err"}`}></span>
                <div className="conn-row-main">
                  <div className="conn-name">{c.name}</div>
                  <div className="conn-url mono">{c.url}</div>
                  <div className="conn-url">{detail}</div>
                </div>
                <button className="btn sm"
                  onClick={() => connMut.update.mutate({ name: c.name, enabled: !c.enabled },
                    { onError: err("Couldn't update connection") })}>
                  {c.enabled ? "Disable" : "Enable"}
                </button>
                <button className="btn sm danger"
                  onClick={() => connMut.remove.mutate(c.name, { onError: err("Remove failed") })}>
                  Remove
                </button>
              </div>
            );
          }) : (
            <div className="dim conn-empty">
              None yet. Point at a Pantheo server's <code>/agora/connect</code> below.
            </div>
          )}
          <div className="conn-add">
            <input id="conn-name" placeholder="name (e.g. home)"
              value={name} onChange={e => setName(e.target.value)} />
            <input id="conn-url" placeholder="wss://my-pantheo:8765/agora/connect"
              value={url} onChange={e => setUrl(e.target.value)} />
            <input id="conn-token" placeholder="PANTHEO_API_TOKEN" type="password"
              value={token} onChange={e => setToken(e.target.value)} />
            <button className="btn sm primary" onClick={() => {
              if (!name.trim() || !url.trim()) return;
              connMut.add.mutate({ name: name.trim(), url: url.trim(), token: token.trim() }, {
                onSuccess: () => { setName(""); setUrl(""); setToken(""); },
                onError: err("Link failed"),
              });
            }}>Link</button>
          </div>
          <p className="conn-hint">Use <code>ws://localhost:8765/agora/connect</code> for a Pantheo running
            on this machine, or the server's public <code>wss://</code> address for a remote one.
            Every agent with Agora enabled on that instance becomes available here.</p>

          <h4>Pairing tokens <span className="dim">— for agents that dial in (OpenClaw, Hermes, bridges)</span></h4>
          {tokens.length ? tokens.map(t => (
            <div key={t.token} className="conn-row">
              <span className="conn-dot off"></span>
              <div className="conn-row-main">
                <div className="conn-name">{t.name}</div>
                <div className="conn-url mono">{t.token}</div>
              </div>
              <button className="btn sm" onClick={() => {
                void navigator.clipboard.writeText(t.token).then(
                  () => toast("Token copied", { variant: "ok" }),
                  () => toast("Couldn't copy", { variant: "warn" }),
                );
              }}>Copy</button>
              <button className="btn sm danger"
                onClick={() => pairMut.revoke.mutate(t.token, { onError: err("Revoke failed") })}>
                Revoke
              </button>
            </div>
          )) : <div className="dim conn-empty">No pairing tokens issued.</div>}
          <div className="conn-add">
            <input id="pair-name" placeholder="label (e.g. openclaw-bridge)"
              value={pairName} onChange={e => setPairName(e.target.value)} />
            <button className="btn sm primary" onClick={() => {
              pairMut.create.mutate(pairName.trim() || "bridge", {
                onSuccess: () => setPairName(""),
                onError: err("Couldn't create token"),
              });
            }}>New token</button>
          </div>
          <p className="conn-hint">A bridge connects to <code>ws://this-host:port/agent/ws?token=…</code>
            and speaks the Agora agent protocol (see docs/protocol.md in the repo).</p>
        </div>
      </div>
    </div>
  );
}

/* PUT /api/instance, then refetch the connections payload it rides on. */
function useRenameInstanceLocal() {
  const rename = useRenameInstance();
  return (name: string) => rename.mutate(name, {
    onSuccess: () => toast("Renamed — relinking so endpoints pick it up…", { variant: "ok" }),
    onError: (e) => toast("Rename failed: " + (e as Error).message, { variant: "warn" }),
  });
}
