/* Fan-out of live agent messages from the (single, app-level) socket to
   whichever screens care right now — the channel screen's speak-aloud and
   the live voice session. A ten-line emitter beats threading callbacks
   through the router. */

import type { Message } from "@agora/core";

type Listener = (m: Message) => void;

const listeners = new Set<Listener>();

export function onAgentMessage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitAgentMessage(m: Message): void {
  for (const fn of listeners) fn(m);
}
