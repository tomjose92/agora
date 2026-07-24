/* Connections overlay (#conn-panel): two tabs — "Connections" lists the instance
   name, linked Pantheo instances (4s status poll while open) and dial-in pairing
   tokens; "Add agent" is a guided flow (pick Pantheo / OpenClaw / Hermes, then
   link or issue a token). Admin only. React-query's refetch keeps typed input
   intact while the poll refreshes. */

import { useEffect, useState } from "react";
import {
  useConnectionMutations, useConnectionsInfo, usePairingMutations, usePairingTokens,
  useRenameInstance,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

type Tab = "list" | "add";
type AddKind = "pantheo" | "claw" | "hermes";

const ADD_KINDS: { kind: AddKind; icon: string; title: string; desc: string }[] = [
  {
    kind: "pantheo", icon: "link", title: "Pantheo instance",
    desc: "Agora dials out to a Pantheo server; every Agora-enabled agent there becomes available.",
  },
  {
    kind: "claw", icon: "bot", title: "OpenClaw",
    desc: "Issue a pairing token; Claw dials in over the agent WebSocket.",
  },
  {
    kind: "hermes", icon: "sparkles", title: "Hermes",
    desc: "Issue a pairing token; Hermes dials in over the agent WebSocket.",
  },
];

const KIND_META: Record<Exclude<AddKind, "pantheo">, { title: string; defaultLabel: string }> = {
  claw: { title: "OpenClaw", defaultLabel: "openclaw" },
  hermes: { title: "Hermes", defaultLabel: "hermes" },
};

function copyText(text: string, what = "Copied") {
  void navigator.clipboard.writeText(text).then(
    () => toast(what, { variant: "ok" }),
    () => toast("Couldn't copy", { variant: "warn" }),
  );
}

/* ws(s):// dial-in address for this Agora, for the token success panel. */
function agentWsUrl(token: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/agent/ws?token=${token}`;
}

/* Cosmetic type badge for a pairing token, inferred from its label. */
function tokenBadge(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("claw")) return "Claw";
  if (n.includes("hermes")) return "Hermes";
  return "Bridge";
}

export function ConnectionsPane() {
  const ui = useUiState();
  const open = ui.panel === "connections";
  const info = useConnectionsInfo(open, open).data;
  const tokens = usePairingTokens(open).data || [];
  const connMut = useConnectionMutations();
  const pairMut = usePairingMutations();
  const [tab, setTab] = useState<Tab>("list");
  const [addKind, setAddKind] = useState<AddKind | null>(null);
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);
  const [instName, setInstName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [pairName, setPairName] = useState("");
  const renameInstance = useRenameInstanceLocal();

  useEffect(() => {
    if (!open) {
      setTab("list"); setAddKind(null); setIssued(null);
      setName(""); setUrl(""); setToken(""); setPairName("");
    }
  }, [open]);

  if (!open) return null;
  const conns = info?.connections || [];
  const instance = info?.instance || null;
  const err = (msg: string) => (e: unknown) =>
    toast(`${msg}: ${(e as Error).message || e}`, { variant: "warn" });

  const goAdd = (kind?: AddKind) => {
    setAddKind(kind ?? null); setIssued(null); setTab("add");
    if (kind && kind !== "pantheo") setPairName(KIND_META[kind].defaultLabel);
  };
  const pickKind = (kind: AddKind) => {
    setAddKind(kind); setIssued(null);
    setPairName(kind === "pantheo" ? "" : KIND_META[kind].defaultLabel);
  };

  const listTab = (
    <>
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
              <div className="conn-name">{c.name} <span className="conn-badge">Pantheo</span></div>
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
          None yet. <button className="btn sm" onClick={() => goAdd("pantheo")}>Link a Pantheo</button>
        </div>
      )}
      <h4>Dial-in agents <span className="dim">— pairing tokens for OpenClaw, Hermes, bridges</span></h4>
      {tokens.length ? tokens.map(t => (
        <div key={t.token} className="conn-row">
          <span className="conn-dot off"></span>
          <div className="conn-row-main">
            <div className="conn-name">{t.name} <span className="conn-badge">{tokenBadge(t.name)}</span></div>
            <div className="conn-url mono">{t.token.slice(0, 10)}…{t.token.slice(-4)}</div>
          </div>
          <button className="btn sm" onClick={() => copyText(t.token, "Token copied")}>Copy</button>
          <button className="btn sm danger"
            onClick={() => pairMut.revoke.mutate(t.token, { onError: err("Revoke failed") })}>
            Revoke
          </button>
        </div>
      )) : (
        <div className="dim conn-empty">
          No pairing tokens issued. <button className="btn sm" onClick={() => goAdd()}>Add an agent</button>
        </div>
      )}
    </>
  );

  const addPicker = (
    <>
      <h4>What are you connecting? <span className="dim">— pick one to get started</span></h4>
      <div className="conn-cards">
        {ADD_KINDS.map(k => (
          <button key={k.kind} className="conn-card" onClick={() => pickKind(k.kind)}>
            <Icon name={k.icon} cls="conn-card-ico" />
            <div className="conn-card-title">{k.title}</div>
            <div className="conn-card-desc">{k.desc}</div>
          </button>
        ))}
      </div>
    </>
  );

  const addPantheo = (
    <>
      <button className="btn sm conn-back" onClick={() => setAddKind(null)}>
        <Icon name="chevron-left" /> All agent types
      </button>
      <h4>Link a Pantheo instance</h4>
      <div className="conn-form">
        <label>Name
          <input id="conn-name" placeholder="e.g. home"
            value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label>Server address
          <input id="conn-url" placeholder="wss://my-pantheo:8765/agora/connect"
            value={url} onChange={e => setUrl(e.target.value)} />
        </label>
        <label>API token
          <input id="conn-token" placeholder="PANTHEO_API_TOKEN" type="password"
            value={token} onChange={e => setToken(e.target.value)} />
        </label>
        <button className="btn sm primary" onClick={() => {
          if (!name.trim() || !url.trim()) { toast("Name and address required", { variant: "warn" }); return; }
          connMut.add.mutate({ name: name.trim(), url: url.trim(), token: token.trim() }, {
            onSuccess: () => {
              setName(""); setUrl(""); setToken("");
              setTab("list"); setAddKind(null);
              toast("Linked — connecting…", { variant: "ok" });
            },
            onError: err("Link failed"),
          });
        }}>Link</button>
      </div>
      <p className="conn-hint">Use <code>ws://localhost:8765/agora/connect</code> for a Pantheo running
        on this machine, or the server's public <code>wss://</code> address for a remote one.
        Every agent with Agora enabled on that instance becomes available here.</p>
    </>
  );

  const addDialIn = (kind: Exclude<AddKind, "pantheo">) => {
    const meta = KIND_META[kind];
    if (issued) {
      return (
        <>
          <h4>{meta.title} token issued</h4>
          <div className="conn-issued">
            <div className="conn-issued-field">
              <span className="conn-issued-label">Pairing token</span>
              <code className="mono">{issued.token}</code>
              <button className="btn sm" onClick={() => copyText(issued.token, "Token copied")}>Copy</button>
            </div>
            <div className="conn-issued-field">
              <span className="conn-issued-label">Connect URL</span>
              <code className="mono">{agentWsUrl(issued.token)}</code>
              <button className="btn sm"
                onClick={() => copyText(agentWsUrl(issued.token), "URL copied")}>Copy</button>
            </div>
            <p className="conn-hint">Point {meta.title} at this URL — it dials in and speaks the Agora
              agent protocol (see <code>docs/protocol.md</code> in the repo).</p>
            <button className="btn sm primary" onClick={() => {
              setIssued(null); setAddKind(null); setTab("list");
            }}>Done</button>
          </div>
        </>
      );
    }
    return (
      <>
        <button className="btn sm conn-back" onClick={() => setAddKind(null)}>
          <Icon name="chevron-left" /> All agent types
        </button>
        <h4>Add {meta.title}</h4>
        <div className="conn-form">
          <label>Label
            <input id="pair-name" placeholder={meta.defaultLabel}
              value={pairName} onChange={e => setPairName(e.target.value)} />
          </label>
          <button className="btn sm primary" onClick={() => {
            const label = pairName.trim() || meta.defaultLabel;
            pairMut.create.mutate(label, {
              onSuccess: r => { setIssued({ token: r.token, name: label }); setPairName(""); },
              onError: err("Couldn't create token"),
            });
          }}>Issue token</button>
        </div>
        <p className="conn-hint">Issuing a token doesn't start anything on this side — {meta.title} uses
          it to dial in whenever it's ready.</p>
      </>
    );
  };

  return (
    <div className="conn-overlay" id="conn-overlay"
      onClick={e => { if (e.target === e.currentTarget) ui.openPanel(null); }}>
      <div className="conn-panel" id="conn-panel">
        <div className="conn-head">
          <b>Connections</b>
          <button className="btn sm" onClick={() => ui.openPanel(null)}><Icon name="x" /></button>
        </div>
        <div className="conn-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "list"}
            className={`conn-tab${tab === "list" ? " active" : ""}`}
            onClick={() => setTab("list")}>Connections</button>
          <button role="tab" aria-selected={tab === "add"}
            className={`conn-tab${tab === "add" ? " active" : ""}`}
            onClick={() => goAdd()}>Add agent</button>
        </div>
        <div className="conn-body">
          {tab === "list" ? listTab
            : addKind === null ? addPicker
            : addKind === "pantheo" ? addPantheo
            : addDialIn(addKind)}
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
