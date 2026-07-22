/* Live event socket — mirrors mobile/src/ws/useAgoraSocket.ts: 1s backoff
   doubling to a 30s cap, reset on open, refetch active queries on re-open
   to heal any gap. Browser twist: visibilitychange/online listeners force
   an immediate reconnect when the tab wakes (the RN AppState equivalent). */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { applyWsEvent, type Message, type WsEvent } from "@agora/core";
import { sessionToken } from "../lib/auth";

const BACKOFF_START = 1000;
const BACKOFF_CAP = 30_000;

export function useAgoraSocket(username: string, onAgentMessage?: (m: Message) => void) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onAgentMessageRef = useRef(onAgentMessage);
  onAgentMessageRef.current = onAgentMessage;

  useEffect(() => {
    if (!username) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = BACKOFF_START;
    let closed = false;
    let everConnected = false;

    const url = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${location.host}/ws?token=${encodeURIComponent(sessionToken())}`;
    };

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(url());
      ws.onopen = () => {
        backoff = BACKOFF_START;
        setConnected(true);
        if (everConnected) void qc.refetchQueries({ type: "active" });
        everConnected = true;
      };
      ws.onmessage = (e) => {
        let ev: WsEvent;
        try { ev = JSON.parse(String(e.data)); } catch { return; }
        applyWsEvent(qc, ev, {
          username,
          onAgentMessage: (m) => onAgentMessageRef.current?.(m),
        });
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_CAP);
      };
    };
    connect();

    const wake = () => {
      if (closed || (ws && ws.readyState === WebSocket.OPEN)) return;
      if (timer) clearTimeout(timer);
      backoff = BACKOFF_START;
      connect();
    };
    const onVis = () => { if (document.visibilityState === "visible") wake(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", wake);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", wake);
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [qc, username]);

  return connected;
}
