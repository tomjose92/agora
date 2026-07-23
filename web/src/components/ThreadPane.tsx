/* Thread side pane (.agora-thread) — the React port of agoDrawThread.
   <ThreadLog key={rootId}> remounts per thread: the mount effect snaps to
   the bottom (fresh open), while same-thread updates preserve the reader's
   place unless they're already at the bottom — the behavior the vanilla UI
   implements by hand with data-root/sameThread/wasAtBottom. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { flashMessage, useJump } from "../state/jump";
import {
  flattenMessages, useAgents, useChannelAgents, useGroups, useMarkThreadRead, useMe,
  useMessage, useMessages, usePinMessage, usePins, useThreads, type Message,
} from "@agora/core";
import { slugify } from "../lib/mentions";
import type { MentionCandidate } from "./Composer";
import { Icon } from "../lib/icons";
import { useUiState } from "../state/ui";
import { buildMentionIndex, type MentionIndex } from "../lib/mentions";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { LiveRows } from "./ChannelPane";
import { LiveButton, LiveStrip, SpeakButton } from "./VoiceControls";

const AT_BOTTOM_PX = 40;

function ThreadLog({ root, replies, isAdmin, mentions }: {
  root: Message;
  replies: Message[];
  isAdmin: boolean;
  mentions?: MentionIndex;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const box = boxRef.current;
    if (box) stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_PX;
  };

  // Fresh mount (new thread) starts at the bottom; afterwards only follow
  // new replies while the reader is already at the bottom.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [replies.length]);

  // Jump-to-message (search/stars landing in this thread): flash it.
  const jumpTarget = useJump(s => s.target);
  const jumpClear = useJump(s => s.clear);
  useEffect(() => {
    if (!jumpTarget || jumpTarget.container !== "thread" || !boxRef.current) return;
    if (flashMessage(boxRef.current, jumpTarget.mid)) {
      stickRef.current = false;
      jumpClear();
    }
  }, [jumpTarget, replies.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ago-log ago-thread-log" id="ago-thread-log" ref={boxRef}
      data-root={root.id} onScroll={onScroll}>
      <MessageItem message={root} inThread isAdmin={isAdmin} mentions={mentions}
        onOpenThread={() => {}} />
      <div className="ago-thread-sep">{replies.length} repl{replies.length === 1 ? "y" : "ies"}</div>
      {replies.map(m => (
        <MessageItem key={m.id} message={m} inThread isAdmin={isAdmin} mentions={mentions}
          onOpenThread={() => {}} />
      ))}
    </div>
  );
}

export function ThreadPane() {
  const ui = useUiState();
  const me = useMe().data;
  const groups = useGroups().data || [];
  const rootId = ui.threadRoot as number;
  const group = groups.find(g => g.id === ui.sel.g) || null;
  const channel = group?.channels?.find(c => c.id === ui.sel.c) || null;

  const q = useMessages(channel?.id || "", rootId);
  const replies = useMemo(() => flattenMessages(q.data), [q.data]);
  // Root fallback: outside the loaded top-level window (inbox, pin, link).
  const topQ = useMessages(channel?.id || "", null);
  const topLevel = useMemo(() => flattenMessages(topQ.data), [topQ.data]);
  const cachedRoot = topLevel.find(m => m.id === rootId);
  const fetchedRoot = useMessage(rootId, !cachedRoot).data;
  const root = cachedRoot || fetchedRoot;

  const threads = useThreads().data || [];
  const threadRow = threads.find(t => t.root.id === rootId);
  const markRead = useMarkThreadRead(rootId);
  const pins = usePins(channel?.id || "").data || [];
  const pinMut = usePinMessage(channel?.id || "");
  const pinned = pins.some(p => p.id === rootId);

  const agents = useChannelAgents(channel?.id || "").data || [];
  // Avatars come from the full /api/agents roster (the channel-agents payload
  // is {id, name} only) — same lookup as vanilla and MessageItem.
  const roster = useAgents().data || [];
  const isAdmin = !!(group && (group.role === "admin" || me?.instance_admin));
  const mentions = useMemo(
    () => buildMentionIndex(agents.map(a => ({ id: a.id, name: a.name })), me ? [me.username] : []),
    [agents, me],
  );
  const candidates = useMemo<MentionCandidate[]>(
    () => agents.map(a => ({
      type: "agent" as const, id: a.id, name: a.name, slug: slugify(a.name),
      avatar: roster.find(r => r.id === a.id)?.avatar || undefined,
    })),
    [agents, roster],
  );

  // Ack replies when the pane is open and the tab is focused.
  const unread = threadRow?.unread || 0;
  useLayoutEffect(() => {
    if (unread > 0 && document.visibilityState === "visible" && document.hasFocus()) {
      markRead.mutate(null);
    }
  }, [unread, rootId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!channel || !root) {
    return <div className="agora-thread" id="agora-thread" style={{ display: "none" }}></div>;
  }

  return (
    <div className="agora-thread" id="agora-thread">
      <div className="ago-head">
        <button className="btn sm ago-back" title={`Back to #${channel.name}`}
          onClick={() => ui.closeThread()}>
          <Icon name="chevron-left" />
        </button>
        <div className="ago-head-text">
          <span className="ago-chan-name">Thread</span>
          <span className="dim ago-thread-chan" title={`Go to #${channel.name}`}
            onClick={() => ui.closeThread()}>
            <span className="hash">#</span>{channel.name}
          </span>
        </div>
        <div className="ago-head-actions">
          {me?.voice && <SpeakButton />}
          {me?.voice && <LiveButton channelId={channel.id} threadId={rootId} />}
          <button className={`btn sm ${pinned ? "active" : ""}`}
            title={pinned ? "Unpin this thread" : "Pin this thread for quick access"}
            onClick={() => pinMut.mutate({ messageId: rootId, pinned: !pinned })}>
            {pinned ? <><Icon name="pin" cls="fill" /> Pinned</> : <><Icon name="pin" /> Pin</>}
          </button>
          <button className="btn sm ago-thread-expand"
            title={ui.threadExpanded ? "Shrink thread back to the side panel" : "Expand thread to full width"}
            onClick={() => ui.toggleThreadSize()}>
            <Icon name={ui.threadExpanded ? "minimize-2" : "maximize-2"} />
          </button>
          <button className="btn sm ago-thread-close" onClick={() => ui.closeThread()}>
            <Icon name="x" />
          </button>
        </div>
      </div>
      <ThreadLog key={rootId} root={root} replies={replies} isAdmin={isAdmin} mentions={mentions} />
      <LiveRows channelId={channel.id} threadId={rootId} />
      <LiveStrip channelId={channel.id} threadId={rootId} />
      <Composer channelId={channel.id} channelName={channel.name} threadId={rootId}
        agents={agents} candidates={candidates} voiceOK={!!me?.voice} />
    </div>
  );
}
