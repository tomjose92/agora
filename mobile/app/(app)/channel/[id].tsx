/* Channel view: inverted infinite list, "New" divider from the read marker,
   live typing/progress, mention-aware composer, pins/stars sheets, and
   long-press message actions (thread / star / pin). */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import {
  flattenMessages,
  useChannelAgents,
  useGroups,
  useMarkRead,
  useMembers,
  useMessages,
  usePinMessage,
  usePins,
  useSendMessage,
  useSeedActivity,
  useStarMessage,
  useStars,
} from "../../../src/api/queries";
import type { Message, PinnedMessage, StarredMessage } from "../../../src/api/types";
import { Composer, type MentionCandidate } from "../../../src/components/Composer";
import { ProgressBubbles, TypingRow } from "../../../src/components/LiveRows";
import { MessageItem } from "../../../src/components/MessageItem";
import { toastErr } from "../../../src/components/Toast";
import { fmtTs } from "../../../src/lib/format";
import { useHeaderKeyboardOffset } from "../../../src/lib/keyboard";
import { colors } from "../../../src/lib/theme";
import { useChannelLive } from "../../../src/state/live";
import { useSession } from "../../../src/state/session";

type Row = { kind: "msg"; m: Message } | { kind: "divider" };

function openThread(channelId: string, root: Message, channelName: string) {
  router.push({
    pathname: "/(app)/thread/[channelId]/[rootId]",
    params: { channelId, rootId: String(root.id), channelName },
  });
}

/* Long-press action sheet. */
function MessageActions({
  message,
  channelId,
  channelName,
  starred,
  pinned,
  onClose,
}: {
  message: Message;
  channelId: string;
  channelName: string;
  starred: boolean;
  pinned: boolean;
  onClose: () => void;
}) {
  const star = useStarMessage(channelId);
  const pin = usePinMessage(channelId);
  const isRoot = message.thread_id == null;
  const act = (fn: () => void) => {
    fn();
    onClose();
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <View style={styles.sheet}>
          {isRoot ? (
            <Pressable
              style={styles.sheetBtn}
              onPress={() => act(() => openThread(channelId, message, channelName))}
            >
              <Text style={styles.sheetText}>💬 Reply in thread</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={styles.sheetBtn}
            onPress={() =>
              act(() =>
                star.mutate(
                  { messageId: message.id, starred: !starred },
                  { onError: (e) => toastErr("Star failed", e) },
                ),
              )
            }
          >
            <Text style={styles.sheetText}>{starred ? "★ Unstar" : "☆ Star"}</Text>
          </Pressable>
          {isRoot ? (
            <Pressable
              style={styles.sheetBtn}
              onPress={() =>
                act(() =>
                  pin.mutate(
                    { messageId: message.id, pinned: !pinned },
                    { onError: (e) => toastErr("Pin failed", e) },
                  ),
                )
              }
            >
              <Text style={styles.sheetText}>{pinned ? "📌 Unpin" : "📌 Pin"}</Text>
            </Pressable>
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

/* Pinned / starred overlays. */
function ListSheet<T extends Message>({
  title,
  items,
  emptyText,
  onPick,
  onClose,
  subtitle,
}: {
  title: string;
  items: T[];
  emptyText: string;
  onPick: (item: T) => void;
  onClose: () => void;
  subtitle: (item: T) => string;
}) {
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <View style={[styles.sheet, styles.listSheet]}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView>
            {items.length === 0 ? <Text style={styles.sheetEmpty}>{emptyText}</Text> : null}
            {items.map((item) => (
              <Pressable key={item.id} style={styles.sheetItem} onPress={() => onPick(item)}>
                <Text style={styles.sheetItemAuthor}>
                  {item.author_name || item.author_id} · {subtitle(item)}
                </Text>
                <Text style={styles.sheetItemText} numberOfLines={2}>
                  {item.text || "(attachment)"}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

export default function ChannelScreen() {
  const params = useLocalSearchParams<{ id: string; name?: string; groupId?: string }>();
  const channelId = params.id;
  const session = useSession((s) => s.session)!;
  const keyboardOffset = useHeaderKeyboardOffset();

  const groups = useGroups();
  const channelMeta = useMemo(() => {
    for (const g of groups.data ?? []) {
      const c = g.channels.find((x) => x.id === channelId);
      if (c) return { channel: c, group: g };
    }
    return null;
  }, [groups.data, channelId]);
  const channelName = params.name || channelMeta?.channel.name || "channel";
  const groupId = params.groupId || channelMeta?.group.id;

  const messages = useMessages(channelId, null);
  const send = useSendMessage(channelId);
  const markRead = useMarkRead(channelId);
  const pins = usePins(channelId);
  const stars = useStars(channelId);
  const channelAgents = useChannelAgents(channelId);
  const members = useMembers(groupId ?? "");
  useSeedActivity(channelId);
  const { typing, progress } = useChannelLive(channelId, null);

  /* "New" divider: snapshot the marker once, when the channel opens. */
  const dividerAfter = useRef<number | null>(null);
  if (dividerAfter.current === null && channelMeta) {
    const { unread, last_read_id } = channelMeta.channel;
    dividerAfter.current = (unread ?? 0) > 0 ? (last_read_id ?? 0) : 0;
  }

  const chronological = useMemo(() => flattenMessages(messages.data), [messages.data]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const marker = dividerAfter.current ?? 0;
    for (const m of chronological) {
      if (marker > 0 && out.length > 0) {
        const prev = out[out.length - 1];
        if (prev.kind === "msg" && prev.m.id <= marker && m.id > marker) {
          out.push({ kind: "divider" });
        }
      }
      out.push({ kind: "msg", m });
    }
    return out;
  }, [chronological]);

  /* Read marker: while the viewer sits at the bottom, every newly-landed
     message is read. Debounced like the desktop's PUT /read. */
  const atBottom = useRef(true);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestId = chronological.length ? chronological[chronological.length - 1].id : 0;
  const unread = channelMeta?.channel.unread ?? 0;
  useEffect(() => {
    if (!atBottom.current || latestId === 0) return;
    if (latestId <= (channelMeta?.channel.last_read_id ?? 0)) return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => markRead.mutate(latestId), 600);
    return () => {
      if (readTimer.current) clearTimeout(readTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId]);

  const listRef = useRef<FlashListRef<Row>>(null);
  const [showJump, setShowJump] = useState(false);

  /* Land on the "New" divider instead of the bottom when there's a backlog
     (Slack behavior) — once, on the first page load. */
  const landedOnDivider = useRef(false);
  useEffect(() => {
    if (landedOnDivider.current || !rows.length) return;
    landedOnDivider.current = true;
    const idx = rows.findIndex((r) => r.kind === "divider");
    if (idx <= 0) return; // no divider (or it's at the very top already)
    // Give FlashList a frame to settle its bottom-anchored initial render.
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0.2 });
    }, 80);
  }, [rows]);

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const agents = (channelAgents.data ?? []).map((a) => ({ id: a.id, name: a.name }));
    const people = (members.data ?? [])
      .filter((m) => m.member_type === "user")
      .map((m) => ({ id: m.member_id, name: m.member_id }));
    return [...agents, ...people];
  }, [channelAgents.data, members.data]);

  const starredIds = useMemo(() => new Set((stars.data ?? []).map((s) => s.id)), [stars.data]);
  const pinnedIds = useMemo(() => new Set((pins.data ?? []).map((p) => p.id)), [pins.data]);

  const groupName = channelMeta?.group.name;
  const openMembers = useCallback(() => {
    if (!groupId) return;
    router.push({
      pathname: "/(app)/members/[groupId]",
      params: { groupId, name: groupName ?? "" },
    });
  }, [groupId, groupName]);

  /* Desktop's "no agents are listening" nudge: any member agent (group-wide
     or scoped to this channel) counts, even if it's currently offline. */
  const noAgents =
    channelAgents.isSuccess &&
    members.isSuccess &&
    (channelAgents.data ?? []).length === 0 &&
    !(members.data ?? []).some(
      (m) => m.member_type === "agent" && (!m.channel_id || m.channel_id === channelId),
    );

  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [sheet, setSheet] = useState<"pins" | "stars" | null>(null);

  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === "divider") {
        return (
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>New</Text>
            <View style={styles.dividerLine} />
          </View>
        );
      }
      return (
        <MessageItem
          session={session}
          message={item.m}
          starred={starredIds.has(item.m.id)}
          pinned={pinnedIds.has(item.m.id)}
          onOpenThread={(root) => openThread(channelId, root, channelName)}
          onLongPress={setActionsFor}
        />
      );
    },
    [session, starredIds, pinnedIds, channelId, channelName],
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: `# ${channelName}`,
          headerShown: true,
          headerRight: () => (
            <View style={styles.headerBtns}>
              <Pressable onPress={() => setSheet("pins")} hitSlop={8}>
                <Text style={styles.headerBtn}>📌</Text>
              </Pressable>
              <Pressable onPress={() => setSheet("stars")} hitSlop={8}>
                <Text style={styles.headerBtn}>⭐</Text>
              </Pressable>
              {groupId ? (
                <Pressable onPress={openMembers} hitSlop={8}>
                  <Text style={styles.headerBtn}>👥</Text>
                </Pressable>
              ) : null}
            </View>
          ),
        }}
      />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        {noAgents && groupId ? (
          <Pressable style={styles.noAgents} onPress={openMembers}>
            <Text style={styles.noAgentsText}>
              No agents are listening in this channel yet — tap to add one under Members.
            </Text>
          </Pressable>
        ) : null}
        <FlashList
          ref={listRef}
          data={rows}
          renderItem={renderRow}
          keyExtractor={(item) => (item.kind === "msg" ? String(item.m.id) : "divider")}
          // Chat layout: render anchored to the bottom, stick to it while
          // the viewer is near it, and keep the viewport stable when older
          // pages prepend at the top.
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.15,
          }}
          onStartReached={() => {
            if (messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage();
          }}
          onStartReachedThreshold={0.4}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            const near = contentOffset.y + layoutMeasurement.height >= contentSize.height - 60;
            atBottom.current = near;
            setShowJump(!near);
          }}
          scrollEventThrottle={64}
          ListHeaderComponent={
            messages.isFetchingNextPage ? (
              <ActivityIndicator color={colors.dim} style={{ paddingVertical: 14 }} />
            ) : null
          }
          ListEmptyComponent={
            messages.isLoading ? (
              <ActivityIndicator color={colors.dim} style={{ paddingVertical: 40 }} />
            ) : (
              <Text style={styles.empty}>No messages yet.</Text>
            )
          }
        />
        {showJump && unread > 0 ? (
          <Pressable
            style={styles.jump}
            onPress={() => {
              listRef.current?.scrollToEnd({ animated: true });
              markRead.mutate(null);
            }}
          >
            <Text style={styles.jumpText}>↓ {unread} new</Text>
          </Pressable>
        ) : null}
        <TypingRow typing={typing} />
        <ProgressBubbles progress={progress} />
        <Composer
          placeholder={`Message # ${channelName}`}
          mentions={mentionCandidates}
          sending={send.isPending}
          onSend={async ({ text, files }) => {
            await send.mutateAsync({ text, threadId: null, files });
          }}
        />
      </KeyboardAvoidingView>
      {actionsFor ? (
        <MessageActions
          message={actionsFor}
          channelId={channelId}
          channelName={channelName}
          starred={starredIds.has(actionsFor.id)}
          pinned={pinnedIds.has(actionsFor.id)}
          onClose={() => setActionsFor(null)}
        />
      ) : null}
      {sheet === "pins" ? (
        <ListSheet<PinnedMessage>
          title="Pinned threads"
          items={pins.data ?? []}
          emptyText="Nothing pinned in this channel."
          subtitle={(p) => `pinned ${fmtTs(p.pinned_at)}`}
          onClose={() => setSheet(null)}
          onPick={(p) => {
            setSheet(null);
            openThread(channelId, p, channelName);
          }}
        />
      ) : null}
      {sheet === "stars" ? (
        <ListSheet<StarredMessage>
          title="Starred messages"
          items={stars.data ?? []}
          emptyText="You haven't starred anything here."
          subtitle={(s) => `starred ${fmtTs(s.starred_at)}`}
          onClose={() => setSheet(null)}
          onPick={(s) => {
            setSheet(null);
            // A starred reply opens its thread; a starred root opens its own.
            openThread(channelId, s.root ?? s, channelName);
          }}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerBtns: { flexDirection: "row", gap: 16 },
  headerBtn: { fontSize: 17 },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 40 },
  noAgents: {
    backgroundColor: "rgba(251,191,36,0.08)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(251,191,36,0.35)",
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  noAgentsText: { color: colors.amber, fontSize: 12.5, lineHeight: 17 },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.red },
  dividerText: { color: colors.red, fontSize: 11.5, fontWeight: "800" },
  jump: {
    position: "absolute",
    right: 16,
    bottom: 130,
    backgroundColor: colors.accent,
    borderRadius: 18,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  jumpText: { color: colors.onAccent, fontSize: 12.5, fontWeight: "800" },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#14161d",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    gap: 4,
    paddingBottom: 34,
  },
  listSheet: { maxHeight: "70%" },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: "800", marginBottom: 8 },
  sheetBtn: { paddingVertical: 13 },
  sheetText: { color: colors.text, fontSize: 15.5 },
  sheetEmpty: { color: colors.dim, paddingVertical: 20, textAlign: "center" },
  sheetItem: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetItemAuthor: { color: colors.a1, fontSize: 12, fontWeight: "700", marginBottom: 2 },
  sheetItemText: { color: colors.text, fontSize: 13.5 },
});
