import { useState } from "react";
import {
  useAgentDmPolicy, useAgentDms, useMe, useOpenAgentDm,
  useUpdateAgentDmPolicy, useUsers,
  type AgentDmCandidate,
} from "@agora/core";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

function PolicyRow({ agent }: { agent: AgentDmCandidate }) {
  const users = useUsers().data || [];
  const policy = useAgentDmPolicy(agent.id).data;
  const update = useUpdateAgentDmPolicy(agent.id);
  if (!policy) return <div className="ago-dm-policy-row dim">Loading {agent.name}…</div>;
  const save = (is_public: boolean, grants: string[]) => update.mutate(
    { is_public, grants },
    { onError: e => toast(`Couldn't update ${agent.name}: ${(e as Error).message}`, { variant: "warn" }) },
  );
  return (
    <div className="ago-dm-policy-row">
      <div className="ago-dm-policy-head">
        <strong>{agent.name}</strong>
        <label><input type="checkbox" checked={policy.is_public}
          onChange={e => save(e.target.checked, policy.grants)} /> Everyone</label>
      </div>
      {!policy.is_public && <div className="ago-dm-grants">
        {users.filter(u => !u.disabled && u.instance_role !== "admin").map(user => (
          <label key={user.username}>
            <input type="checkbox" checked={policy.grants.includes(user.username)}
              onChange={e => save(policy.is_public, e.target.checked
                ? [...policy.grants, user.username]
                : policy.grants.filter(x => x !== user.username))} />
            {user.display_name || user.username}
          </label>
        ))}
      </div>}
    </div>
  );
}

export function AgentDmPanel({ onClose }: { onClose: () => void }) {
  const me = useMe().data;
  const data = useAgentDms();
  const openDm = useOpenAgentDm();
  const ui = useUiState();
  const [admin, setAdmin] = useState(false);
  const agents = data.data?.agents || [];
  return (
    <div className="ago-dm-popover" role="dialog" aria-label="Agent direct messages">
      <div className="ago-dm-popover-head">
        <strong>{admin ? "Agent DM access" : "New direct message"}</strong>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      {me?.instance_admin && <button className="btn sm" onClick={() => setAdmin(!admin)}>
        {admin ? "Choose an agent" : "Manage access"}
      </button>}
      {admin ? agents.map(agent => <PolicyRow key={agent.id} agent={agent} />) : (
        <div className="ago-dm-agent-list">
          {agents.filter(a => a.can_dm).map(agent => <button key={agent.id} className="ago-dm-agent"
            onClick={() => openDm.mutate(agent.id, { onSuccess: channel => {
              ui.selectChannel("__dms", channel.id); onClose();
            }, onError: e => toast(`Couldn't open DM: ${(e as Error).message}`, { variant: "warn" }) })}>
            <span>{agent.name}</span><span className={agent.live ? "ok" : "dim"}>{agent.live ? "online" : "offline"}</span>
          </button>)}
          {!agents.some(a => a.can_dm) && <div className="dim">No agents are available to you yet.</div>}
        </div>
      )}
    </div>
  );
}
