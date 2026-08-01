/* Native conversation section navigation. The narrow, intentionally
   touch-capturing strip overlays a message list without reducing bubble
   width; long timelines use a fixed window instead of a nested scroller. */

import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  conversationSections,
  type ConversationSection,
  type Message,
} from "@agora/core";
import { colors } from "../lib/theme";

export const MAX_VISIBLE_SECTION_DOTS = 12;

/** Keep a fixed-size, non-scrollable window around the active section. */
export function visibleSectionWindow<T>(
  items: T[],
  active: number,
  max = MAX_VISIBLE_SECTION_DOTS,
): T[] {
  if (items.length <= max) return items;
  const half = Math.floor(max / 2);
  const start = Math.max(0, Math.min(active - half, items.length - max));
  return items.slice(start, start + max);
}

export function activeSectionIndex(
  sections: ConversationSection[],
  messageId: number | null,
): number {
  if (!sections.length || messageId == null) return 0;
  let active = 0;
  for (let i = 1; i < sections.length; i += 1) {
    if (sections[i].mid > messageId) break;
    active = i;
  }
  return active;
}

export function messageRowIndex(
  rows: readonly unknown[],
  messageId: number,
): number {
  return rows.findIndex((row) => {
    if (typeof row !== "object" || row === null || !("m" in row)) return false;
    const message = (row as { m?: Pick<Message, "id"> }).m;
    return message?.id === messageId;
  });
}

export function SectionRail({
  messages,
  activeMessageId,
  onJump,
  bottomInset = 12,
}: {
  messages: Message[];
  activeMessageId: number | null;
  onJump: (messageId: number) => void;
  bottomInset?: number;
}) {
  const sections = useMemo(() => conversationSections(messages), [messages]);
  const active = activeSectionIndex(sections, activeMessageId);
  const visible = visibleSectionWindow(sections, active);

  if (sections.length < 2) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.rail, { bottom: bottomInset }]}
    >
      {visible.map((section) => {
        const selected = section.mid === sections[active]?.mid;
        return (
          <View key={section.mid} pointerEvents="box-none" style={styles.slot}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Jump to: ${section.label}`}
              accessibilityState={{ selected }}
              hitSlop={{ top: 3, bottom: 3, left: 6, right: 6 }}
              onPress={() => onJump(section.mid)}
              style={[styles.dot, selected && styles.dotActive]}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: "absolute",
    zIndex: 5,
    right: 2,
    top: "9%",
    width: 20,
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
  },
  slot: {
    width: 20,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.dim,
    opacity: 0.55,
  },
  dotActive: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.accent,
    opacity: 1,
  },
});
