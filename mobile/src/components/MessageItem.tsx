import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Session } from "../api/client";
import type { Message } from "../api/types";
import { fmtTs } from "../lib/format";
import { colors } from "../lib/theme";
import { Attachments } from "./Attachments";
import { MdText } from "./MdText";

export function Avatar({ message }: { message: Message }) {
  if (message.author_type === "agent") {
    return (
      <View style={[styles.avatar, styles.avatarAgent]}>
        <Text style={styles.avatarEmoji}>🤖</Text>
      </View>
    );
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
  return (
    <Pressable onLongPress={() => onLongPress?.(message)} delayLongPress={300}>
      <View style={styles.row}>
        <Avatar message={message} />
        <View style={styles.body}>
          <View style={styles.head}>
            <Text style={styles.author} numberOfLines={1}>
              {message.author_name || message.author_id}
            </Text>
            <Text style={styles.ts}>{fmtTs(message.ts)}</Text>
            {pinned ? <Text style={styles.flag}>📌</Text> : null}
            {starred ? <Text style={styles.flag}>⭐</Text> : null}
          </View>
          <MdText text={message.text} />
          <Attachments session={session} attachments={message.attachments ?? []} />
          {onOpenThread && (message.reply_count ?? 0) > 0 ? (
            <Pressable onPress={() => onOpenThread(message)} hitSlop={6}>
              <Text style={styles.replies}>
                {message.reply_count} {message.reply_count === 1 ? "reply" : "replies"} →
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.panelStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarAgent: { backgroundColor: "rgba(139,124,255,0.15)" },
  avatarEmoji: { fontSize: 17 },
  avatarInitial: { color: colors.a2, fontSize: 15, fontWeight: "700" },
  body: { flex: 1, gap: 2 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { color: colors.text, fontSize: 14, fontWeight: "700", flexShrink: 1 },
  ts: { color: colors.faint, fontSize: 11.5 },
  flag: { fontSize: 11 },
  replies: { color: colors.a1, fontSize: 12.5, fontWeight: "600", marginTop: 4 },
});
