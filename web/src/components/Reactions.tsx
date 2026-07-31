/* Reaction chips + the trailing add button. The picker itself lives in
   EmojiPicker. */

import { useEffect, useRef, useState } from "react";
import { useAgents, useMe, useToggleReaction, useUsers, type Message, type Reaction } from "@agora/core";
import { Icon } from "../lib/icons";
import { withToken } from "../lib/files";

export function Reactions({ message, onPick }: {
  message: Message;
  onPick: (anchor: HTMLElement) => void;
}) {
  const me = useMe().data;
  const toggle = useToggleReaction();
  const [open, setOpen] = useState<string | null>(null);
  const hold = useRef<number | null>(null);
  const held = useRef(false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const list = message.reactions || [];
  if (!list.length) return null;
  return (
    <div className="ago-reacts">
      {list.map(r => {
        const users = r.users || [];
        const mine = !!me && (r.reactors
          ? r.reactors.some(x => x.type === "user" && x.id === me.username)
          : users.includes(me.username));
        const reactors = `${users.join(", ")} reacted with ${r.emoji}`;
        return (
          <span key={r.emoji} className="ago-react-wrap" onMouseEnter={() => setOpen(r.emoji)} onMouseLeave={() => setOpen(null)}>
            <button className={`ago-react ${mine ? "mine" : ""}`}
              aria-label={reactors} aria-describedby={open === r.emoji ? `reactors-${message.id}-${r.emoji}` : undefined}
              onFocus={() => setOpen(r.emoji)} onBlur={() => setOpen(null)}
              onPointerDown={() => { held.current = false; hold.current = window.setTimeout(() => { held.current = true; setOpen(r.emoji); }, 450); }}
              onPointerUp={() => { if (hold.current) window.clearTimeout(hold.current); }}
              onPointerCancel={() => { if (hold.current) window.clearTimeout(hold.current); }}
              onClick={() => { if (held.current) { held.current = false; return; } toggle.mutate({ message, emoji: r.emoji, on: !mine }); }}>
              {r.emoji}<span className="rc">{users.length}</span>
            </button>
            {open === r.emoji ? <ReactorPopover id={`reactors-${message.id}-${r.emoji}`} reaction={r} /> : null}
          </span>
        );
      })}
      <button className="ago-react ago-react-add" title="Add reaction"
        onClick={e => onPick(e.currentTarget)}>
        <Icon name="smile" />
      </button>
    </div>
  );
}

function ReactorPopover({ id, reaction }: { id: string; reaction: Reaction }) {
  const users = useUsers().data || [];
  const agents = useAgents().data || [];
  const reactors = reaction.reactors ?? reaction.users.map(name => ({ type: "user" as const, id: name, name }));
  return <div id={id} className="ago-react-pop" role="tooltip">
    <strong>{reaction.emoji} reactions</strong>
    {reactors.map(r => {
      const agent = r.type === "agent" ? agents.find(a => a.id === r.id) : undefined;
      const user = r.type === "user" ? users.find(u => u.username === r.id) : undefined;
      const name = agent?.name || user?.display_name || r.name;
      return <div className="ago-reactor" key={`${r.type}:${r.id}`}>
        <ReactorAvatar type={r.type} name={name} avatar={agent?.avatar} />
        <span><b>{name}</b><small>@{r.id} · {r.type}</small></span>
      </div>;
    })}
  </div>;
}

function ReactorAvatar({ type, name, avatar }: { type: "user" | "agent"; name: string; avatar?: string | null }) {
  const [failed, setFailed] = useState(false);
  return <span className={`ago-reactor-av ${type}${avatar && !failed ? " has-avatar" : ""}`}>
    {avatar && !failed
      ? <img src={withToken(avatar)} alt="" onError={() => setFailed(true)} />
      : type === "agent" ? <Icon name="bot" /> : name[0]?.toUpperCase()}
  </span>;
}
