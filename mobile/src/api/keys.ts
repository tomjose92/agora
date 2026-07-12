/* Query-key factory. Thread pages are keyed by root id (0 = top level) so
   the WS reducer can address exactly the list a new message belongs to. */

export const keys = {
  me: ["me"] as const,
  groups: ["groups"] as const,
  messages: (channelId: string, threadId: number | null) =>
    ["messages", channelId, threadId ?? 0] as const,
  message: (id: number) => ["message", id] as const,
  threads: ["threads"] as const,
  pins: (channelId: string) => ["pins", channelId] as const,
  stars: (channelId: string) => ["stars", channelId] as const,
  channelAgents: (channelId: string) => ["channelAgents", channelId] as const,
  activity: (channelId: string) => ["activity", channelId] as const,
  members: (groupId: string) => ["members", groupId] as const,
  agents: ["agents"] as const,
  search: (q: string, scope: string) => ["search", q, scope] as const,
  connections: ["connections"] as const,
  pairing: ["pairing"] as const,
};
