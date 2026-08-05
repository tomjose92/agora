/** Binary agent presence, distinct from connection transport health. */
export function AgentStatus({ live }: { live: boolean }) {
  const label = live ? "online" : "offline";
  return <span className={`agent-presence ${live ? "online" : "offline"}`}>
    <span className="agent-presence-dot" aria-hidden="true" />
    <span>{label}</span>
  </span>;
}
