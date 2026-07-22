/* Toggle a reaction knowing only the message id (the emoji picker's case):
   find the message in the query caches, then flip my membership — the
   React counterpart of agoToggleReaction/agoFindMessage. */

import { useQueryClient } from "@tanstack/react-query";
import {
  useApi, useMe, keys, replaceMessage,
  type Message, type MessagePages,
} from "@agora/core";
import { toast } from "../lib/toast";

export function useToggleReactionById() {
  const qc = useQueryClient();
  const api = useApi();
  const me = useMe().data;

  return async (mid: number, emoji: string) => {
    // Search every cached message page set for the id.
    let message: Message | undefined;
    for (const [, data] of qc.getQueriesData<MessagePages>({ queryKey: ["messages"] })) {
      message = data?.pages.flat().find(m => m.id === mid);
      if (message) break;
    }
    if (!message || !me) return;
    const mine = (message.reactions || []).some(r =>
      r.emoji === emoji && (r.users || []).includes(me.username));
    const path = `/api/channels/${encodeURIComponent(message.channel_id)}`
      + `/messages/${mid}/reactions/${encodeURIComponent(emoji)}`;
    try {
      const updated = mine ? await api.delete<Message>(path) : await api.put<Message>(path);
      qc.setQueryData<MessagePages>(
        keys.messages(updated.channel_id, updated.thread_id),
        (data) => replaceMessage(data, updated),
      );
    } catch (e) {
      toast("Couldn't react: " + (e as Error).message, { variant: "warn" });
    }
  };
}
