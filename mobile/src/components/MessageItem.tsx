/* Chat bubbles, mirroring the desktop's agoBubble: your own messages sit on
   the right in an accent bubble; agents and other people sit on the left with
   an avatar and author line. */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Pin, Star } from "lucide-react-native";
import type { Session } from "../api/client";
import { useSelectOption } from "../api/queries";
import type { Message } from "../api/types";
import { fmtTs } from "../lib/format";
import { colors } from "../lib/theme";
import { useSession } from "../state/session";
import { AgentAvatar } from "./AgentAvatar";
import { Attachments } from "./Attachments";
import { Icon } from "./Icon";
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

function MessageOptions({ message }: { message: Message }) {
  const select = useSelectOption();
  const meta = message.meta;
  const options = meta?.options;
  if (!options || options.length === 0) return null;
  const resolved = meta?.resolved;
  if (resolved) {
    const label =
      resolved.label ||
      options.find((o) => o.id === resolved.option_id)?.label ||
      resolved.option_id ||
      "Resolved";
    const by = resolved.by ? ` by ${resolved.by}` : "";
    return (
      <View style={styles.options}>
        <Text style={styles.optionResult}>
          {label}
          {by}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.options}>
      {options.map((o) => (
        <Pressable
          key={o.id}
          style={[
            styles.optionBtn,
            o.style === "primary" && styles.optionPrimary,
            o.style === "danger" && styles.optionDanger,
          ]}
          onPress={() => select.mutate({ messageId: message.id, optionId: o.id })}
          disabled={select.isPending}
        >
          <Text
            style={[
              styles.optionLabel,
              o.style === "primary" && styles.optionPrimaryLabel,
              o.style === "danger" && styles.optionDangerLabel,
            ]}
          >
            {o.label || o.id}
          </Text>
        </Pressable>
      ))}
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
      {pinned ? <Icon icon={Pin} size={11} color={colors.a1} /> : null}
      {starred ? <Icon icon={Star} size={11} color={colors.amber} fill={colors.amber} /> : null}
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

  /* Long-press-to-star must NOT come from a Pressable wrapping the bubble:
     on the iOS new architecture a parent Pressable steals the pan gesture
     from a nested horizontal ScrollView (facebook/react-native#56879), which
     made wide markdown tables unscrollable. Instead the text blocks carry
     onLongPress themselves (via MdText) and an absolute-fill backdrop behind
     the content catches long-presses on the bubble's padding and gaps — the
     table's ScrollView never has a Pressable ancestor. */
  const longPress = onLongPress ? () => onLongPress(message) : undefined;
  const pressBackdrop = longPress ? (
    <Pressable style={StyleSheet.absoluteFill} onLongPress={longPress} delayLongPress={300} />
  ) : null;

  if (mine) {
    return (
      <View style={[styles.row, styles.rowMine]}>
        <View style={[styles.bubble, styles.bubbleMine]}>
          {pressBackdrop}
          <MdText text={message.text} onLongPress={longPress} />
          <Attachments session={session} attachments={message.attachments ?? []} />
          <MessageOptions message={message} />
          <View style={styles.foot}>
            {flags}
            <Text style={styles.ts}>{fmtTs(message.ts)}</Text>
          </View>
          {replies}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Avatar message={message} />
      <View style={[styles.bubble, styles.bubbleOther]}>
        {pressBackdrop}
        <View style={styles.head}>
          <Text style={styles.author} numberOfLines={1}>
            {message.author_name || message.author_id}
            {message.author_type === "agent" ? <Text style={styles.agentTag}> · agent</Text> : null}
          </Text>
          {flags}
          <Text style={styles.ts}>{fmtTs(message.ts)}</Text>
        </View>
        <MdText text={message.text} onLongPress={longPress} />
        <Attachments session={session} attachments={message.attachments ?? []} />
        <MessageOptions message={message} />
        {replies}
      </View>
    </View>
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
    maxWidth: "86%",
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
  replies: { color: colors.a1, fontSize: 12.5, fontWeight: "600", marginTop: 4 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  optionBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panelStrong,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  optionPrimary: {
    backgroundColor: "rgba(72,187,120,0.18)",
    borderColor: "rgba(72,187,120,0.45)",
  },
  optionDanger: {
    backgroundColor: "rgba(239,68,68,0.14)",
    borderColor: "rgba(239,68,68,0.4)",
  },
  optionLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
  optionPrimaryLabel: { color: "#6ee7a0" },
  optionDangerLabel: { color: "#fca5a5" },
  optionResult: { color: colors.faint, fontSize: 12, fontWeight: "600" },
});
