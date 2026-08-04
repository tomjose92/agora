import { useAgentDms, useOpenAgentDm } from "@agora/core";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

export function AgentDmPanel({ onClose }: { onClose: () => void }) {
  const data = useAgentDms();
  const openDm = useOpenAgentDm();
  const ui = useUiState();
  const existing = new Set((data.data?.conversations || []).map(dm => dm.agent_id));
  const agents = (data.data?.agents || []).filter(agent => agent.can_dm && !existing.has(agent.id));
  return (
    <div className="ago-dm-popover" role="dialog" aria-label="Start an agent direct message">
      <div className="ago-dm-popover-head">
        <strong>New direct message</strong>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
      <div className="ago-dm-agent-list">
        {agents.map(agent => <button key={agent.id} className="ago-dm-agent"
          disabled={openDm.isPending}
          onClick={() => openDm.mutate(agent.id, { onSuccess: channel => {
            ui.selectChannel("__dms", channel.id); onClose();
          }, onError: e => toast(`Couldn't open DM: ${(e as Error).message}`, { variant: "warn" }) })}>
          <span>{agent.name}</span><span className={agent.live ? "ok" : "dim"}>{agent.live ? "online" : "offline"}</span>
        </button>)}
        {data.isLoading && <div className="dim">Loading agents…</div>}
        {data.isError && <div className="dim">Couldn't load available agents.</div>}
        {data.isSuccess && !agents.length && <div className="dim">No new agents are available to message.</div>}
      </div>
    </div>
  );
}
