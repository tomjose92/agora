/* The channel message log (.ago-log#ago-log): stick-to-bottom scrolling,
   the "New" divider landed on when entering a channel with unreads, the
   jump-to-latest bar, and visible+focused+at-bottom mark-read — the React
   port of agoDrawMessages/agoOnScroll/agoMaybeMarkRead. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  flattenMessages, useGroups, useMarkRead, useMessages, type Message,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { type MentionIndex } from "../lib/mentions";
import { MessageItem } from "./MessageItem";

const AT_BOTTOM_PX = 48;

export function MessageLog({ channelId, isAdmin, mentions, onOpenThread }: {
  channelId: string;
  isAdmin: boolean;
  mentions?: MentionIndex;
  onOpenThread: (rootId: number) => void;
}) {
  const groups = useGroups().data || [];
  const q = useMessages(channelId, null);
  const markRead = useMarkRead(channelId);
  const messages = useMemo(() => flattenMessages(q.data), [q.data]);

  const boxRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);           // was the user at the bottom pre-render?
  const landOnDividerRef = useRef(false);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const channel = groups.flatMap(g => g.channels || []).find(c => c.id === channelId);
  const unread = channel?.unread || 0;

  /* Divider position is captured once per channel entry (like
     _agoDividerChan): after the last-read id at the moment of entry. */
  const dividerAfterRef = useRef<number | null>(null);
  const dividerChanRef = useRef<string | null>(null);
  if (dividerChanRef.current !== channelId) {
    dividerChanRef.current = channelId;
    dividerAfterRef.current = unread > 0 ? (channel?.last_read_id || 0) : null;
    landOnDividerRef.current = dividerAfterRef.current != null;
    stickRef.current = true;
  }

  const maybeMarkRead = () => {
    const box = boxRef.current;
    if (!box || document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight >= AT_BOTTOM_PX) return;
    if (!unread && !messages.length) return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      if (unread > 0) markRead.mutate(null);
    }, 400);
  };

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < AT_BOTTOM_PX;
    if (stickRef.current) maybeMarkRead();
  };

  // Initial land + follow new messages while stuck to the bottom.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (landOnDividerRef.current && dividerRef.current) {
      landOnDividerRef.current = false;
      stickRef.current = false;
      box.scrollTop = Math.max(0, dividerRef.current.offsetTop - 8);
    } else if (stickRef.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [messages.length, channelId]);

  useEffect(() => { maybeMarkRead(); });

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") maybeMarkRead(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  });

  const jumpToLatest = () => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
    stickRef.current = true;
    maybeMarkRead();
  };

  let dividerPlaced = false;
  const rows: React.ReactNode[] = [];
  for (const m of messages as Message[]) {
    if (!dividerPlaced && dividerAfterRef.current != null && m.id > dividerAfterRef.current) {
      rows.push(
        <div key="divider" className="ago-new-divider" id="ago-new-divider" ref={dividerRef}>
          <span>New</span>
        </div>,
      );
      dividerPlaced = true;
    }
    rows.push(
      <MessageItem key={m.id} message={m} inThread={false} isAdmin={isAdmin}
        mentions={mentions} onOpenThread={onOpenThread} />,
    );
  }

  return (
    <>
      {unread > 0 && (
        <div className="ago-unread-bar" id="ago-unread-bar">
          <span className="ago-unread-n">{unread} new message{unread === 1 ? "" : "s"}</span>
          <button className="lnk" onClick={jumpToLatest}>Jump to latest <Icon name="arrow-down" /></button>
          <button className="lnk dim" onClick={() => markRead.mutate(null)}>Mark as read</button>
        </div>
      )}
      <div className="ago-log" id="ago-log" ref={boxRef} onScroll={onScroll}>
        {rows.length ? rows : (
          <div className="empty">
            <div className="glyph"><Icon name="message-circle" /></div>
            <div>No messages yet</div>
            <div className="hint">Say something — member agents will answer here. Use the Members button to invite an agent.</div>
          </div>
        )}
      </div>
    </>
  );
}
