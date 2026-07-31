import { hasMine as coreHasMine, type Reaction, type ReactionReactor } from "@agora/core";

export function hasMine(reaction: Reaction, username: string): boolean {
  return coreHasMine(reaction, username);
}

export function legacyReactors(reaction: Reaction): ReactionReactor[] {
  return reaction.reactors
    ?? reaction.users.map((name) => ({ type: "user", id: name, name }));
}

export function reactorNames(reaction: Reaction): string[] {
  return reaction.reactors?.map((reactor) => reactor.name) ?? reaction.users;
}
