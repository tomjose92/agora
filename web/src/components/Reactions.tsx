/* Reaction chips + the trailing add button — same markup as
   agoReactionsHTML. The picker itself lives in EmojiPicker. */

import { useMe, useToggleReaction, type Message } from "@agora/core";
import { Icon } from "../lib/icons";

export function Reactions({ message, onPick }: {
  message: Message;
  onPick: (anchor: HTMLElement) => void;
}) {
  const me = useMe().data;
  const toggle = useToggleReaction();
  const list = message.reactions || [];
  if (!list.length) return null;
  return (
    <div className="ago-reacts">
      {list.map(r => {
        const users = r.users || [];
        const mine = !!me && users.includes(me.username);
        const reactors = `${users.join(", ")} reacted with ${r.emoji}`;
        return (
          <button key={r.emoji} className={`ago-react ${mine ? "mine" : ""}`}
            aria-label={reactors}
            data-reactors={reactors}
            onClick={() => toggle.mutate({ message, emoji: r.emoji, on: !mine })}>
            {r.emoji}<span className="rc">{users.length}</span>
          </button>
        );
      })}
      <button className="ago-react ago-react-add" title="Add reaction"
        onClick={e => onPick(e.currentTarget)}>
        <Icon name="smile" />
      </button>
    </div>
  );
}
