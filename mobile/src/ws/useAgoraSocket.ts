/* Live event socket. Same reconnect scheme as ui/agora.js: 1s backoff
   doubling to a 30s cap, reset on a successful open. On every (re)open we
   refetch active queries to heal any gap, and the OS AppState listener
   forces a fresh connect when the app returns to the foreground. */

import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { wsUrl, type Session } from "../api/client";
import type { Message, WsEvent } from "../api/types";
import { applyWsEvent } from "./reducer";

const BACKOFF_START = 1000;
const BACKOFF_CAP = 30_000;

export function useAgoraSocket(
  session: Session,
  username: string,
  onAgentMessage?: (message: Message) => void,
) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const onAgentMessageRef = useRef(onAgentMessage);
  onAgentMessageRef.current = onAgentMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = BACKOFF_START;
    let closed = false;
    let everConnected = false;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl(session));
      ws.onopen = () => {
        backoff = BACKOFF_START;
        setConnected(true);
        if (everConnected) {
          // Events may have been missed while disconnected.
          void qc.refetchQueries({ type: "active" });
        }
        everConnected = true;
      };
      ws.onmessage = (e) => {
        let ev: WsEvent;
        try {
          ev = JSON.parse(String(e.data));
        } catch {
          return;
        }
        applyWsEvent(qc, ev, {
          username,
          onAgentMessage: (m) => onAgentMessageRef.current?.(m),
        });
      };
      ws.onerror = () => {
        /* onclose follows; reconnect happens there */
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_CAP);
      };
    };
    connect();

    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || closed) return;
      // A backgrounded socket is often silently dead: reconnect immediately.
      if (ws && ws.readyState === WebSocket.OPEN) return;
      if (timer) clearTimeout(timer);
      backoff = BACKOFF_START;
      connect();
    });

    return () => {
      closed = true;
      sub.remove();
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [qc, session.baseUrl, session.token, username]);

  return connected;
}
