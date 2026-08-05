import { useState } from "react";
import { useAgents } from "@agora/core";
import { withToken } from "../lib/files";
import { Icon } from "../lib/icons";

/** Shared authenticated agent picture with a deterministic bot fallback. */
export function AgentAvatar({ agentId, avatar, small = false, className = "", title, onClick }: {
  agentId?: string; avatar?: string | null; small?: boolean; className?: string;
  title?: string; onClick?: () => void;
}) {
  const roster = useAgents().data || [];
  const [failed, setFailed] = useState(false);
  const resolved = avatar ?? roster.find(agent => agent.id === agentId)?.avatar;
  const classes = `ago-av${small ? " sm" : ""}${className ? ` ${className}` : ""}`;
  const common = onClick ? { role: "button", tabIndex: 0, onClick, title } : { title };
  if (resolved && !failed) return <span className={`${classes} has-avatar`} {...common}>
    <img src={withToken(resolved)} alt="" onError={() => setFailed(true)} />
  </span>;
  return <span className={classes} {...common}><Icon name="bot" /></span>;
}
