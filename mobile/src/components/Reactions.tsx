/* Reaction chips under a message bubble: one chip per emoji with a count,
   the caller's own reactions highlighted; tapping toggles. Rendered only
   when the message has reactions — adding the first one goes through the
   long-press sheet. */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Smile } from "lucide-react-native";
import type { Message } from "../api/types";
import { useToggleReaction } from "../api/queries";
import { colors } from "../lib/theme";
import { useSession } from "../state/session";
import { Icon } from "./Icon";

/** Returns react(message, emoji): adds the caller's reaction, or removes it
    when they already reacted with that emoji — picker taps are toggles. */
export function useReactWith() {
  const username = useSession((s) => s.username);
  const toggle = useToggleReaction();
  return (message: Message, emoji: string) => {
    const mine =
      username !== "" &&
      (message.reactions ?? []).some((r) => r.emoji === emoji && r.users.includes(username));
    toggle.mutate({ message, emoji, on: !mine });
  };
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏"];

/** The common-few row for the long-press sheet, plus a "more" button that
    hands off to the full emoji picker. */
export function QuickReactions({
  message,
  onDone,
  onMore,
}: {
  message: Message;
  onDone: () => void;
  onMore: () => void;
}) {
  const username = useSession((s) => s.username);
  const react = useReactWith();
  return (
    <View style={styles.quickRow}>
      {QUICK_REACTIONS.map((emoji) => {
        const mine =
          username !== "" &&
          (message.reactions ?? []).some((r) => r.emoji === emoji && r.users.includes(username));
        return (
          <Pressable
            key={emoji}
            style={[styles.quick, mine && styles.chipMine]}
            onPress={() => {
              react(message, emoji);
              onDone();
            }}
          >
            <Text style={styles.quickEmoji}>{emoji}</Text>
          </Pressable>
        );
      })}
      <Pressable style={styles.quick} onPress={onMore}>
        <Icon icon={Smile} size={20} color={colors.dim} />
      </Pressable>
    </View>
  );
}

export function Reactions({ message }: { message: Message }) {
  const username = useSession((s) => s.username);
  const toggle = useToggleReaction();
  const list = message.reactions ?? [];
  if (list.length === 0) return null;
  return (
    <View style={styles.row}>
      {list.map((r) => {
        const mine = username !== "" && r.users.includes(username);
        return (
          <Pressable
            key={r.emoji}
            style={[styles.chip, mine && styles.chipMine]}
            onPress={() => toggle.mutate({ message, emoji: r.emoji, on: !mine })}
            disabled={toggle.isPending}
          >
            <Text style={styles.emoji}>{r.emoji}</Text>
            <Text style={[styles.count, mine && styles.countMine]}>{r.users.length}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 999,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  chipMine: {
    backgroundColor: "rgba(139,124,255,0.14)",
    borderColor: "rgba(139,124,255,0.5)",
  },
  emoji: { fontSize: 14 },
  count: { color: colors.dim, fontSize: 11.5, fontWeight: "700" },
  countMine: { color: "#cfc8ff" },
  quickRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    marginBottom: 6,
  },
  quick: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  quickEmoji: { fontSize: 22 },
});
