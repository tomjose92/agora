/* Chat bubbles, mirroring the desktop's agoBubble: your own messages sit on
   the right in an accent bubble; agents and other people sit on the left with
   an avatar and author line. */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Session } from "../api/client";
import type { Message } from "../api/types";
import { fmtTs } from "../lib/format";
import { colors } from "../lib/theme";
import { useSession } from "../state/session";
import { AgentAvatar } from "./AgentAvatar";
import { Attachments } from "./Attachments";
import { MdText } from "./MdText";

export function Avatar({ message }: { message: Message }) {
  if (message.author_type === "agent") {
    return <AgentAvatar agentId={message.author_id} size={30} />;
  }
  const initial = (message.author_name || message.author_id || "?")[0].toUpperCase();
  return (
    <View style={styles.avatar}>
      <Text style={styles.avatarInitial}>{initial}</Text>
    </View>
  );
}

export function MessageItem({
  session,
  message,
  onOpenThread,
  onLongPress,
  starred,
  pinned,
}: {
  session: Session;
  message: Message;
  onOpenThread?: (root: Message) => void;
  onLongPress?: (message: Message) => void;
  starred?: boolean;
  pinned?: boolean;
}) {
  const username = useSession((s) => s.username);
  const mine =
    message.author_type === "user" && username !== "" && message.author_id === username;

  const flags = (
    <>
      {pinned ? <Text style={styles.flag}>📌</Text> : null}
      {starred ? <Text style={styles.flag}>⭐</Text> : null}
    </>
  );

  const replies =
    onOpenThread && (message.reply_count ?? 0) > 0 ? (
      <Pressable onPress={() => onOpenThread(message)} hitSlop={6}>
        <Text style={styles.replies}>
          {message.reply_count} {message.reply_count === 1 ? "reply" : "replies"} →
        </Text>
      </Pressable>
    ) : null;

  if (mine) {
    return (
      <Pressable onLongPress={() => onLongPress?.(message)} delayLongPress={300}>
        <View style={[styles.row, styles.rowMine]}>
          <View style={[styles.bubble, styles.bubbleMine]}>
            <MdText text={message.text} />
            <Attachments session={session} attachments={message.attachments ?? []} />
            <View style={styles.foot}>
              {flags}
              <Text style={styles.ts}>{fmtTs(message.ts)}</Text>
            </View>
            {replies}
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable onLongPress={() => onLongPress?.(message)} delayLongPress={300}>
      <View style={styles.row}>
        <Avatar message={message} />
        <View style={[styles.bubble, styles.bubbleOther]}>
          <View style={styles.head}>
            <Text style={styles.author} numberOfLines={1}>
              {message.author_name || message.author_id}
              {message.author_type === "agent" ? <Text style={styles.agentTag}> · agent</Text> : null}
            </Text>
            {flags}
            <Text style={styles.ts}>{fmtTs(message.ts)}</Text>
          </View>
          <MdText text={message.text} />
          <Attachments session={session} attachments={message.attachments ?? []} />
          {replies}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  rowMine: { justifyContent: "flex-end" },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: colors.panelStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: { color: colors.a2, fontSize: 14, fontWeight: "700" },
  bubble: {
    maxWidth: "78%",
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 9,
    gap: 2,
  },
  bubbleMine: {
    backgroundColor: "rgba(139,124,255,0.22)",
    borderWidth: 1,
    borderColor: "rgba(139,124,255,0.3)",
    borderBottomRightRadius: 5,
  },
  bubbleOther: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 5,
    flexShrink: 1,
  },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
    marginTop: 2,
  },
  author: { color: colors.text, fontSize: 13, fontWeight: "700", flexShrink: 1 },
  agentTag: { color: colors.faint, fontSize: 11, fontWeight: "600" },
  ts: { color: colors.faint, fontSize: 10.5 },
  flag: { fontSize: 10.5 },
  replies: { color: colors.a1, fontSize: 12.5, fontWeight: "600", marginTop: 4 },
});
