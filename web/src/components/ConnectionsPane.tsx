/* Admin-only connection manager. "Add agent" presents branded, guided setup
   for local coding CLIs alongside hosted agent integrations and Pantheo. */

import { useEffect, useMemo, useState } from "react";
import {
  type PairingKind,
  type PairingToken,
  useConnectionMutations, useConnectionsInfo, usePairingMutations, usePairingTokens,
  useRenameInstance,
} from "@agora/core";
import claudeLogo from "../assets/agents/claude.png";
import codexLogo from "../assets/agents/codex.png";
import cursorLogo from "../assets/agents/cursor.png";
import hermesLogo from "../assets/agents/hermes.png";
import openClawLogo from "../assets/agents/openclaw.png";
import pantheoLogo from "../assets/agents/pantheo.png";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

type Tab = "list" | "add";
type AddKind = "pantheo" | "coding" | PairingKind;
type ConnectableKind = Exclude<AddKind, "coding">;

interface AddDefinition {
  kind: ConnectableKind;
  icon?: string;
  logo?: string;
  title: string;
  shortTitle: string;
  desc: string;
  defaultLabel: string;
  local?: boolean;
  directory?: string;
}

const ADD_DEFINITIONS: AddDefinition[] = [
  {
    kind: "codex", logo: codexLogo, title: "Codex CLI", shortTitle: "Codex",
    desc: "Continue Codex sessions and work on repositories from Agora.",
    defaultLabel: "Codex", local: true, directory: "codex-cli",
  },
  {
    kind: "cursor", logo: cursorLogo, title: "Cursor CLI", shortTitle: "Cursor",
    desc: "Run Cursor CLI against projects on your computer.",
    defaultLabel: "Cursor", local: true, directory: "cursor-cli",
  },
  {
    kind: "claude", logo: claudeLogo, title: "Claude Code", shortTitle: "Claude",
    desc: "Continue Claude Code sessions from any Agora channel.",
    defaultLabel: "Claude", local: true, directory: "claude-cli",
  },
  {
    kind: "hermes", logo: hermesLogo, title: "Hermes", shortTitle: "Hermes",
    desc: "Give Hermes secure access to join rooms in this Agora.",
    defaultLabel: "Hermes",
  },
  {
    kind: "claw", logo: openClawLogo, title: "OpenClaw", shortTitle: "OpenClaw",
    desc: "Create secure access for an OpenClaw agent.",
    defaultLabel: "OpenClaw",
  },
  {
    kind: "pantheo", logo: pantheoLogo, title: "Pantheo instance", shortTitle: "Pantheo",
    desc: "Link another server and make all of its Agora-enabled agents available.",
    defaultLabel: "",
  },
];

const DEFINITION_BY_KIND = Object.fromEntries(
  ADD_DEFINITIONS.map(definition => [definition.kind, definition]),
) as Record<ConnectableKind, AddDefinition>;

function copyText(text: string, what = "Copied") {
  void navigator.clipboard.writeText(text).then(
    () => toast(what, { variant: "ok" }),
    () => toast("Couldn't copy", { variant: "warn" }),
  );
}

function inferredKind(token: PairingToken): PairingKind | null {
  if (token.kind && token.kind in DEFINITION_BY_KIND) return token.kind;
  const value = token.name.toLowerCase();
  if (value.includes("codex")) return "codex";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("claude")) return "claude";
  if (value.includes("claw")) return "claw";
  if (value.includes("hermes")) return "hermes";
  return null;
}

function displayDefinition(token: PairingToken): AddDefinition | null {
  const kind = inferredKind(token);
  return kind ? DEFINITION_BY_KIND[kind] : null;
}

function guidePath(definition: AddDefinition): string | null {
  return definition.local ? `/docs/coding-agents/${definition.kind}.html` : null;
}

function AgentMark({ definition, small = false }: { definition: AddDefinition | null; small?: boolean }) {
  if (definition?.logo) {
    return <img className={`conn-agent-logo${small ? " small" : ""}`} src={definition.logo} alt="" />;
  }
  return (
    <span className={`conn-agent-glyph${small ? " small" : ""}`}>
      <Icon name={definition?.icon || "bot"} />
    </span>
  );
}

function CommandBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="conn-command">
      <code>{text}</code>
      <button className="btn sm" onClick={() => copyText(text, `${label} copied`)}>
        <Icon name="file-text" /> Copy
      </button>
    </div>
  );
}

function AgentCard({ definition, onSelect }: { definition: AddDefinition; onSelect: () => void }) {
  const guide = guidePath(definition);
  return (
    <article className="conn-card">
      <button className="conn-card-select" onClick={onSelect}>
        <div className="conn-card-top">
          <AgentMark definition={definition} />
          {definition.local && <span className="conn-local-badge">Runs on your computer</span>}
        </div>
        <div className="conn-card-title">
          {definition.title}<Icon name="chevron-right" />
        </div>
        <div className="conn-card-desc">{definition.desc}</div>
      </button>
      {guide && (
        <a className="conn-guide-link" href={guide} target="_blank" rel="noopener noreferrer">
          Setup guide <Icon name="external-link" />
        </a>
      )}
    </article>
  );
}

export function ConnectionsPane() {
  const ui = useUiState();
  const open = ui.panel === "connections";
  const info = useConnectionsInfo(open, open).data;
  const tokens = usePairingTokens(open, open).data || [];
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
  const err = (message: string) => (error: unknown) =>
    toast(`${message}: ${(error as Error).message || error}`, { variant: "warn" });

  const goAdd = (kind?: AddKind) => {
    setAddKind(kind ?? null); setIssued(null); setTab("add");
    setPairName(kind && kind !== "pantheo" && kind !== "coding"
      ? DEFINITION_BY_KIND[kind].defaultLabel
      : "");
  };

  const listTab = (
    <>
      {instance && (
        <>
          <h4>This Agora <span className="dim">— how linked instances label this app's chats</span></h4>
          <div className="conn-add">
            <input id="inst-name" value={instName ?? (instance.name || "")}
              placeholder="name (e.g. Home Agora)"
              onChange={event => setInstName(event.target.value)} />
            <button className="btn sm primary" onClick={() => {
              const value = (instName ?? instance.name ?? "").trim();
              if (!value) { toast("Name required", { variant: "warn" }); return; }
              renameInstance(value);
              setInstName(null);
            }}>Rename</button>
          </div>
          <p className="conn-hint">Sessions and channel bindings on a linked Pantheo carry this name
            (instance id <code>{(instance.id || "").slice(0, 8)}</code>), so several Agoras stay distinct.</p>
        </>
      )}
      <h4>Pantheo instances <span className="dim">— linked agent servers</span></h4>
      {conns.length ? conns.map(connection => {
        const status = connection.status;
        const agents = (status?.agents || []).map(agent => agent.name || agent.id).join(", ");
        const detail = status?.connected
          ? (agents ? `agents: ${agents}` : "linked, no agents offered")
          : (status?.last_error ? String(status.last_error).slice(0, 120) : "connecting…");
        return (
          <div key={connection.name} className="conn-row">
            <AgentMark definition={DEFINITION_BY_KIND.pantheo} small />
            <span className={`conn-dot ${status?.connected ? "on" : "err"}`} />
            <div className="conn-row-main">
              <div className="conn-name">{connection.name} <span className="conn-badge">Pantheo</span></div>
              <div className="conn-url mono">{connection.url}</div>
              <div className="conn-url">{detail}</div>
            </div>
            <button className="btn sm"
              onClick={() => connMut.update.mutate(
                { name: connection.name, enabled: !connection.enabled },
                { onError: err("Couldn't update connection") },
              )}>
              {connection.enabled ? "Disable" : "Enable"}
            </button>
            <button className="btn sm danger"
              onClick={() => connMut.remove.mutate(connection.name, { onError: err("Remove failed") })}>
              Remove
            </button>
          </div>
        );
      }) : (
        <div className="dim conn-empty">
          None yet. <button className="btn sm" onClick={() => goAdd("pantheo")}>Link a Pantheo</button>
        </div>
      )}
      <h4>Connected agents <span className="dim">— secure access for CLIs and integrations</span></h4>
      {tokens.length ? tokens.map(pairing => {
        const definition = displayDefinition(pairing);
        const liveNames = (pairing.agents || []).map(agent => agent.name || agent.id).join(", ");
        const detail = pairing.connected
          ? (liveNames ? `Live: ${liveNames}` : "Connected, registering…")
          : "Offline";
        return (
          <div key={pairing.token} className="conn-row">
            <AgentMark definition={definition} small />
            <span className={`conn-dot ${pairing.connected ? "on" : "off"}`} />
            <div className="conn-row-main">
              <div className="conn-name">
                {pairing.name}
                <span className="conn-badge">{definition?.shortTitle || "Agent CLI"}</span>
              </div>
              <div className="conn-url mono">{pairing.token.slice(0, 10)}…{pairing.token.slice(-4)}</div>
              <div className="conn-url">{detail}</div>
            </div>
            <button className="btn sm" onClick={() => copyText(pairing.token, "Token copied")}>Copy</button>
            <button className="btn sm danger"
              onClick={() => pairMut.revoke.mutate(pairing.token, { onError: err("Revoke failed") })}>
              Revoke
            </button>
          </div>
        );
      }) : (
        <div className="dim conn-empty">
          No agent access created. <button className="btn sm" onClick={() => goAdd()}>Add an agent</button>
        </div>
      )}
    </>
  );

  const addPicker = (
    <div className="conn-catalog">
      <div className="conn-intro">
        <span className="conn-kicker">Bring your agents into the conversation</span>
        <h3>What would you like to connect?</h3>
        <p>Link an agent service or choose a coding agent that runs on your computer.</p>
      </div>
      <div className="conn-cards top-level">
        <AgentCard definition={DEFINITION_BY_KIND.pantheo} onSelect={() => goAdd("pantheo")} />
        <article className="conn-card">
          <button className="conn-card-select" onClick={() => goAdd("coding")}>
            <div className="conn-card-top">
              <span className="conn-logo-stack" aria-hidden>
                <img src={codexLogo} alt="" /><img src={cursorLogo} alt="" /><img src={claudeLogo} alt="" />
              </span>
              <span className="conn-local-badge">Runs on your computer</span>
            </div>
            <div className="conn-card-title">Coding agents <Icon name="chevron-right" /></div>
            <div className="conn-card-desc">Connect Codex CLI, Cursor CLI, or Claude Code.</div>
          </button>
        </article>
        <AgentCard definition={DEFINITION_BY_KIND.hermes} onSelect={() => goAdd("hermes")} />
        <AgentCard definition={DEFINITION_BY_KIND.claw} onSelect={() => goAdd("claw")} />
      </div>
    </div>
  );

  const codingPicker = (
    <>
      <BackButton onClick={() => setAddKind(null)} label="All connection types" />
      <div className="conn-intro conn-coding-intro">
        <span className="conn-kicker">Runs on your computer</span>
        <h3>Choose a coding agent</h3>
        <p>Continue local coding sessions and repository work from Agora.</p>
      </div>
      <div className="conn-cards">
        {(["codex", "cursor", "claude"] as const).map(kind => (
          <AgentCard key={kind} definition={DEFINITION_BY_KIND[kind]} onSelect={() => goAdd(kind)} />
        ))}
      </div>
    </>
  );

  const addPantheo = (
    <>
      <BackButton onClick={() => setAddKind(null)} />
      <h4>Link a Pantheo instance</h4>
      <div className="conn-form">
        <label>Name
          <input id="conn-name" placeholder="e.g. home" value={name}
            onChange={event => setName(event.target.value)} />
        </label>
        <label>Server address
          <input id="conn-url" placeholder="wss://my-pantheo:8765/agora/connect" value={url}
            onChange={event => setUrl(event.target.value)} />
        </label>
        <label>API token
          <input id="conn-token" placeholder="PANTHEO_API_TOKEN" type="password" value={token}
            onChange={event => setToken(event.target.value)} />
        </label>
        <button className="btn sm primary" onClick={() => {
          if (!name.trim() || !url.trim()) {
            toast("Name and address required", { variant: "warn" }); return;
          }
          connMut.add.mutate({ name: name.trim(), url: url.trim(), token: token.trim() }, {
            onSuccess: () => {
              setName(""); setUrl(""); setToken(""); setTab("list"); setAddKind(null);
              toast("Linked — connecting…", { variant: "ok" });
            },
            onError: err("Link failed"),
          });
        }}>Link</button>
      </div>
      <p className="conn-hint">Use <code>ws://localhost:8765/agora/connect</code> for Pantheo on
        this machine, or its public <code>wss://</code> address for a remote server.</p>
    </>
  );

  const addAgent = (kind: PairingKind) => {
    const definition = DEFINITION_BY_KIND[kind];
    if (issued && definition.local) {
      return (
        <CliSetup
          definition={definition}
          issued={issued}
          connected={tokens.some(item => item.token === issued.token && item.connected)}
          liveAgent={tokens.find(item => item.token === issued.token)?.agents?.[0]?.name}
          onDone={() => { setIssued(null); setAddKind(null); setTab("list"); }}
        />
      );
    }
    if (issued) {
      return (
        <div className="conn-issued">
          <div className="conn-success-mark"><Icon name="check" /></div>
          <h3 className="conn-setup-title">{definition.title} access created</h3>
          <p className="conn-setup-copy">Use this credential in {definition.title}'s Agora settings.</p>
          <CommandBlock text={issued.token} label="Token" />
          <button className="btn primary conn-done"
            onClick={() => { setIssued(null); setAddKind(null); setTab("list"); }}>Done</button>
        </div>
      );
    }
    return (
      <>
        <BackButton onClick={() => setAddKind(null)} />
        <div className="conn-setup-head">
          <AgentMark definition={definition} />
          <div>
            <span className="conn-step-label">Step 1 of {definition.local ? "3" : "1"}</span>
            <h3 className="conn-setup-title">Create access for {definition.title}</h3>
            {guidePath(definition) && (
              <a className="conn-setup-guide" href={guidePath(definition)!} target="_blank"
                rel="noopener noreferrer">Open full setup guide <Icon name="external-link" /></a>
            )}
          </div>
        </div>
        {definition.local && (
          <div className="conn-stepper" aria-label="Setup progress">
            <span className="active" /><span /><span />
          </div>
        )}
        <p className="conn-setup-copy">Choose a friendly name so you can recognize this agent later.</p>
        <div className="conn-form conn-token-form">
          <label>Agent name
            <input id="pair-name" placeholder={definition.defaultLabel} autoFocus value={pairName}
              onChange={event => setPairName(event.target.value)} />
          </label>
          <button className="btn primary" disabled={pairMut.create.isPending} onClick={() => {
            const label = pairName.trim() || definition.defaultLabel;
            pairMut.create.mutate({ name: label, kind }, {
              onSuccess: result => {
                setIssued({ token: result.token, name: label });
                setPairName("");
              },
              onError: err("Couldn't create access"),
            });
          }}>{pairMut.create.isPending ? "Creating…" : definition.local ? "Continue" : "Create access"}</button>
        </div>
        {definition.local && (
          <p className="conn-security-note">
            <Icon name="lock" />
            This CLI runs on your computer and can access only what its local configuration allows.
          </p>
        )}
      </>
    );
  };

  return (
    <div className="conn-overlay" id="conn-overlay"
      onClick={event => { if (event.target === event.currentTarget) ui.openPanel(null); }}>
      <div className="conn-panel" id="conn-panel" role="dialog" aria-modal="true" aria-label="Connections">
        <div className="conn-head">
          <b>Connections</b>
          <button className="btn sm" aria-label="Close connections"
            onClick={() => ui.openPanel(null)}><Icon name="x" /></button>
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
            : addKind === "coding" ? codingPicker
            : addKind === "pantheo" ? addPantheo
            : addAgent(addKind)}
        </div>
      </div>
    </div>
  );
}

function BackButton({ onClick, label = "All agent types" }: { onClick: () => void; label?: string }) {
  return (
    <button className="btn sm conn-back" onClick={onClick}>
      <Icon name="chevron-left" /> {label}
    </button>
  );
}

function CliSetup({
  definition, issued, connected, liveAgent, onDone,
}: {
  definition: AddDefinition;
  issued: { token: string; name: string };
  connected: boolean;
  liveAgent?: string;
  onDone: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const envText = useMemo(() => (
    `AGORA_URL=${location.origin}\nAGORA_PAIRING_TOKEN=${issued.token}`
  ), [issued.token]);
  const directory = definition.directory!;
  const startCommand = `python3 -m pip install websockets\ncp -n bridges/${directory}/.env.example bridges/${directory}/.env`;

  return (
    <>
      <BackButton onClick={onDone} />
      <div className="conn-setup-head">
        <AgentMark definition={definition} />
        <div>
          <span className="conn-step-label">Step {connected ? "3" : "2"} of 3</span>
          <h3 className="conn-setup-title">
            {connected ? `${liveAgent || definition.shortTitle} is connected` : `Set up ${definition.title}`}
          </h3>
          <a className="conn-setup-guide" href={guidePath(definition)!} target="_blank"
            rel="noopener noreferrer">Open full setup guide <Icon name="external-link" /></a>
        </div>
      </div>
      <div className="conn-stepper" aria-label="Setup progress">
        <span className="done" /><span className={connected ? "done" : "active"} />
        <span className={connected ? "active" : ""} />
      </div>
      {connected ? (
        <div className="conn-connected">
          <div className="conn-connected-orbit"><AgentMark definition={definition} /></div>
          <h3>Ready for a channel</h3>
          <p>Add {liveAgent || definition.shortTitle} from a channel's member picker, then start or resume a session.</p>
          <button className="btn primary" onClick={onDone}>View connections</button>
        </div>
      ) : (
        <>
          <p className="conn-setup-copy">
            On the computer where you use {definition.title}, open a terminal in the Agora repository.
          </p>
          <ol className="conn-instructions">
            <li>
              <b>Prepare the Agora agent</b>
              <CommandBlock text={startCommand} label="Setup command" />
            </li>
            <li>
              <b>Add these two lines to <code>bridges/{directory}/.env</code></b>
              <CommandBlock text={envText} label="Configuration" />
            </li>
            <li>
              <b>Start it</b>
              <CommandBlock text={`python3 bridges/${directory}/bridge.py`} label="Start command" />
            </li>
          </ol>
          <div className="conn-waiting" role="status">
            <span className="conn-wait-pulse" />
            <div><b>Waiting for {definition.shortTitle}…</b><span>This screen will update automatically.</span></div>
          </div>
          <a className="conn-troubleshoot" href={`${guidePath(definition)}#troubleshooting`}
            target="_blank" rel="noopener noreferrer">Having trouble? Open troubleshooting</a>
          <button className="conn-advanced-toggle" aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced(value => !value)}>
            Advanced setup <Icon name={showAdvanced ? "chevron-up" : "chevron-down"} />
          </button>
          {showAdvanced && (
            <div className="conn-advanced">
              <p>Pairing token</p>
              <CommandBlock text={issued.token} label="Token" />
              <p>WebSocket URL</p>
              <CommandBlock text={agentWsUrl(issued.token)} label="WebSocket URL" />
            </div>
          )}
        </>
      )}
    </>
  );
}

function agentWsUrl(token: string): string {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}/agent/ws?token=${token}`;
}

function useRenameInstanceLocal() {
  const rename = useRenameInstance();
  return (name: string) => rename.mutate(name, {
    onSuccess: () => toast("Renamed — relinking so endpoints pick it up…", { variant: "ok" }),
    onError: error => toast("Rename failed: " + (error as Error).message, { variant: "warn" }),
  });
}
