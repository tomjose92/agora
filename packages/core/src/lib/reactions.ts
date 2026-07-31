import type { Reaction } from "../api/types";

/** Whether a reaction belongs to this person. Typed identities take
    precedence; `users` is only the compatibility path for older servers. */
export function hasMine(reaction: Reaction, username: string): boolean {
  return reaction.reactors
    ? reaction.reactors.some((reactor) => reactor.type === "user" && reactor.id === username)
    : reaction.users.includes(username);
}
