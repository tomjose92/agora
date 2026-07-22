/* Thread view: the root message pinned at the top, replies below, and a
   composer that posts with thread_id (the server folds reply-to-reply back
   to the root, same as resolve_thread in server.rs).

   Upgraded to match the channel screen: FlashList with pagination and
   bottom anchoring, a root fallback fetch for threads opened from the inbox
   or a notification (whose root isn't in the loaded top-level window),
   per-thread read acking while the viewer sits at the bottom, long-press
   star, and user mentions in the composer. */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { Headphones, Maximize2, Minimize2, Star, Trash2, Volume2 } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@agora/core";
import { useSendVoice } from "../../../../src/api/voice";
import {
  flattenMessages,
  useChannelAgents,
  useDeleteMessage,
  useGroups,
  useMarkThreadRead,
  useMembers,
  useMessage,
  useMessages,
  useSendMessage,
  useStarMessage,
  useStars,
} from "@agora/core";
import type { Message, ThreadRow } from "@agora/core";
import { Composer, type MentionCandidate } from "../../../../src/components/Composer";
import { EmojiPicker } from "../../../../src/components/EmojiPicker";
import { Icon } from "../../../../src/components/Icon";
import { ProgressBubbles, TypingRow } from "../../../../src/components/LiveRows";
import { MessageItem } from "../../../../src/components/MessageItem";
import { ProfileSheet } from "../../../../src/components/ProfileSheet";
import { QuickReactions, useReactWith } from "../../../../src/components/Reactions";
import { toastErr } from "../../../../src/components/Toast";
import { onAgentMessage } from "../../../../src/lib/agentBus";
import { headerActions } from "../../../../src/lib/headerItems";
import { useHeaderKeyboardOffset } from "../../../../src/lib/keyboard";
import {
  enqueueSpeech,
  prepareSpeechAudio,
  stopSpeech,
} from "../../../../src/lib/speech";
import { colors } from "../../../../src/lib/theme";
import { threadAddressKey } from "@agora/core";
import { useChannelLive } from "@agora/core";
import { usePrefs } from "../../../../src/state/prefs";
import { useSession } from "../../../../src/state/session";
import { tldrOf, useTldrView } from "@agora/core";

type Row = { kind: "root"; m: Message } | { kind: "msg"; m: Message };

export default function ThreadScreen() {
  const params = useLocalSearchParams<{
    channelId: string;
    rootId: string;
    channelName?: string;
  }>();
  const channelId = params.channelId;
  const rootId = Number(params.rootId);
  const session = useSession((s) => s.session)!;
  const keyboardOffset = useHeaderKeyboardOffset();
  const qc = useQueryClient();

  const replies = useMessages(channelId, rootId);
  const topLevel = useMessages(channelId, null);
  const send = useSendMessage(channelId);
  const sendVoice = useSendVoice(channelId);
  const voiceOk = useSession((s) => s.voiceOk);
  const channelAgents = useChannelAgents(channelId);
  const stars = useStars(channelId);
  const star = useStarMessage(channelId);
  const markThreadRead = useMarkThreadRead(rootId);
  const { typing, progress } = useChannelLive(channelId, rootId);

  const groups = useGroups();
  const { groupId, groupRole, resolvedChannelName } = useMemo(() => {
    for (const g of groups.data ?? []) {
      const c = g.channels.find((x) => x.id === channelId);
      if (c) return { groupId: g.id, groupRole: g.role, resolvedChannelName: c.name };
    }
    return { groupId: null, groupRole: null, resolvedChannelName: null };
  }, [groups.data, channelId]);
  const members = useMembers(groupId ?? "");
  const channelName = params.channelName || resolvedChannelName;

  /* Tapping the header title jumps to the thread's channel. `navigate`
     (not `push`) pops back to the channel screen when the thread was opened
     from it, instead of stacking a duplicate. */
  const openChannel = useCallback(() => {
    router.navigate({
      pathname: "/(app)/channel/[id]",
      params: { id: channelId, name: channelName ?? "", groupId: groupId ?? "" },
    });
  }, [channelId, channelName, groupId]);

  // The root usually sits in the already-loaded top-level page set; when it
  // doesn't (inbox / notification / old pin), fetch it directly.
  const cachedRoot = useMemo(
    () => flattenMessages(topLevel.data).find((m) => m.id === rootId) ?? null,
    [topLevel.data, rootId],
  );
  const fetchedRoot = useMessage(rootId, cachedRoot === null);
  const root = cachedRoot ?? fetchedRoot.data ?? null;

  const thread = useMemo(() => flattenMessages(replies.data), [replies.data]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (root) out.push({ kind: "root", m: root });
    for (const m of thread) out.push({ kind: "msg", m });
    return out;
  }, [root, thread]);

  /* Read acking: while the viewer sits at the bottom, new replies are read.
     Mirrors the channel screen's channel-marker debounce. */
  const atBottom = useRef(true);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestId = thread.length ? thread[thread.length - 1].id : 0;
  useEffect(() => {
    if (!atBottom.current || latestId === 0) return;
    const row = qc
      .getQueryData<ThreadRow[]>(keys.threads)
      ?.find((t) => t.root.id === rootId);
    if (row && latestId <= row.last_read_id) return;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => markThreadRead.mutate(latestId), 600);
    return () => {
      if (readTimer.current) clearTimeout(readTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId]);

  const agentCandidates = useMemo<MentionCandidate[]>(
    () => (channelAgents.data ?? []).map((a) => ({ id: a.id, name: a.name })),
    [channelAgents.data],
  );
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const people = (members.data ?? [])
      .filter((m) => m.member_type === "user")
      .map((m) => ({ id: m.member_id, name: m.member_id }));
    return [...agentCandidates, ...people];
  }, [agentCandidates, members.data]);

  const starredIds = useMemo(() => new Set((stars.data ?? []).map((s) => s.id)), [stars.data]);
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [reactFor, setReactFor] = useState<Message | null>(null);
  const reactWith = useReactWith();
  const [profileFor, setProfileFor] = useState<Message | null>(null);
  const toggleTldr = useTldrView((s) => s.toggle);
  const showingTldr = useTldrView((s) => s.showing);

  /* Delete gating: the sender, or any group admin (the groups payload's
     `role` already folds in instance admins). Deleting the root takes the
     whole thread, so the screen pops back to the channel. */
  const del = useDeleteMessage();
  const username = useSession((s) => s.username);
  const canDelete = (m: Message) =>
    groupRole === "admin" ||
    (m.author_type === "user" && username !== "" && m.author_id === username);
  const confirmDelete = (m: Message) => {
    Alert.alert(
      "Delete message?",
      m.id === rootId
        ? "This deletes the message and its whole thread for everyone."
        : "This deletes the message for everyone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            del.mutate(
              { message: m },
              {
                onError: (e) => toastErr("Delete failed", e),
                onSuccess: () => {
                  if (m.id === rootId) router.back();
                },
              },
            ),
        },
      ],
    );
  };

  /* 🔊 speak-aloud: while this thread is focused (and not covered by the
     live screen), agent replies landing in it are read out via server TTS —
     the thread-scoped mirror of the channel screen's effect. */
  const speakAloud = usePrefs((s) => s.speakAloud);
  const setSpeakAloud = usePrefs((s) => s.setSpeakAloud);
  useFocusEffect(
    useCallback(() => {
      if (!voiceOk || !speakAloud) return;
      void prepareSpeechAudio();
      const off = onAgentMessage((m) => {
        if (m.channel_id === channelId && m.thread_id === rootId) {
          enqueueSpeech(session, m.id);
        }
      });
      return () => {
        off();
        stopSpeech();
      };
    }, [voiceOk, speakAloud, channelId, rootId, session]),
  );

  /* 🎧 live voice scoped to this thread: turns post as replies here. */
  const openLive = useCallback(() => {
    stopSpeech();
    router.push({
      pathname: "/(app)/live/[channelId]",
      params: {
        channelId,
        channelName: params.channelName ?? "",
        rootId: String(rootId),
        rootSnippet: (root?.text ?? "").slice(0, 80),
      },
    });
  }, [channelId, params.channelName, rootId, root?.text]);

  const listRef = useRef<FlashListRef<Row>>(null);

  const renderRow = useCallback(
    ({ item }: { item: Row }) => (
      <View style={item.kind === "root" ? styles.rootMsg : undefined}>
        <MessageItem
          session={session}
          message={item.m}
          starred={starredIds.has(item.m.id)}
          onLongPress={setActionsFor}
          onAvatarPress={setProfileFor}
        />
      </View>
    ),
    [session, starredIds],
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () =>
            channelName ? (
              <Pressable onPress={openChannel} hitSlop={6}>
                <Text style={styles.headerTitle}>
                  Thread · <Text style={styles.headerChan}># {channelName}</Text>
                </Text>
              </Pressable>
            ) : (
              <Text style={styles.headerTitle}>Thread</Text>
            ),
          headerShown: true,
          ...headerActions(
            voiceOk ? (
              <View style={styles.headerBtns}>
                <Pressable
                  onPress={() => {
                    if (speakAloud) stopSpeech();
                    setSpeakAloud(!speakAloud);
                  }}
                  hitSlop={8}
                >
                  <View style={!speakAloud && styles.headerBtnOff}>
                    <Icon icon={Volume2} size={20} color={colors.text} />
                  </View>
                </Pressable>
                <Pressable onPress={openLive} hitSlop={8}>
                  <Icon icon={Headphones} size={20} color={colors.text} />
                </Pressable>
              </View>
            ) : null,
          ),
        }}
      />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        <FlashList
          ref={listRef}
          data={rows}
          renderItem={renderRow}
          keyExtractor={(item) =>
            item.kind === "root" ? `root-${item.m.id}` : String(item.m.id)
          }
          // Tight threshold for the same reason as the channel screen: a
          // wider band lets an incoming reply yank an upward-scrolling
          // viewer back to the bottom.
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.05,
          }}
          onStartReached={() => {
            if (replies.hasNextPage && !replies.isFetchingNextPage) void replies.fetchNextPage();
          }}
          onStartReachedThreshold={0.4}
          onScroll={(e) => {
            const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
            atBottom.current =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 60;
          }}
          scrollEventThrottle={64}
          // Mounted whenever older history exists (see the channel screen).
          ListHeaderComponent={
            replies.hasNextPage ? (
              <ActivityIndicator color={colors.dim} style={{ paddingVertical: 14 }} />
            ) : null
          }
          ListEmptyComponent={
            replies.isLoading || (cachedRoot === null && fetchedRoot.isLoading) ? (
              <ActivityIndicator color={colors.dim} style={{ paddingVertical: 40 }} />
            ) : (
              <Text style={styles.empty}>No replies yet.</Text>
            )
          }
        />
        <TypingRow typing={typing} />
        <ProgressBubbles progress={progress} />
        <Composer
          placeholder="Reply in thread"
          mentions={mentionCandidates}
          agents={agentCandidates}
          addressKey={threadAddressKey(channelId, rootId)}
          sending={send.isPending}
          onSend={async ({ text, files }) => {
            await send.mutateAsync({ text, threadId: rootId, files });
          }}
          onSendVoice={
            voiceOk
              ? async (file, mentions) => {
                  await sendVoice.mutateAsync({ file, threadId: rootId, mentions });
                }
              : undefined
          }
        />
      </KeyboardAvoidingView>
      {actionsFor ? (
        <Modal transparent animationType="fade" onRequestClose={() => setActionsFor(null)}>
          <Pressable style={styles.sheetBackdrop} onPress={() => setActionsFor(null)}>
            <View style={styles.sheet}>
              <QuickReactions
                message={actionsFor}
                onDone={() => setActionsFor(null)}
                onMore={() => {
                  setReactFor(actionsFor);
                  setActionsFor(null);
                }}
              />
              {tldrOf(actionsFor) != null ? (
                <Pressable
                  style={styles.sheetBtn}
                  onPress={() => {
                    toggleTldr(actionsFor.id);
                    setActionsFor(null);
                  }}
                >
                  <Icon
                    icon={showingTldr[actionsFor.id] ? Maximize2 : Minimize2}
                    size={18}
                    color={colors.text}
                  />
                  <Text style={styles.sheetText}>
                    {showingTldr[actionsFor.id] ? "Show full message" : "Show TL;DR"}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                style={styles.sheetBtn}
                onPress={() => {
                  const starred = starredIds.has(actionsFor.id);
                  star.mutate(
                    { messageId: actionsFor.id, starred: !starred },
                    { onError: (e) => toastErr("Star failed", e) },
                  );
                  setActionsFor(null);
                }}
              >
                <Icon
                  icon={Star}
                  size={18}
                  color={starredIds.has(actionsFor.id) ? colors.amber : colors.text}
                  fill={starredIds.has(actionsFor.id) ? colors.amber : "none"}
                />
                <Text style={styles.sheetText}>
                  {starredIds.has(actionsFor.id) ? "Unstar" : "Star"}
                </Text>
              </Pressable>
              {canDelete(actionsFor) ? (
                <Pressable
                  style={styles.sheetBtn}
                  onPress={() => {
                    const m = actionsFor;
                    setActionsFor(null);
                    confirmDelete(m);
                  }}
                >
                  <Icon icon={Trash2} size={18} color={colors.red} />
                  <Text style={[styles.sheetText, styles.sheetDanger]}>Delete</Text>
                </Pressable>
              ) : null}
            </View>
          </Pressable>
        </Modal>
      ) : null}
      <EmojiPicker
        visible={reactFor != null}
        onPick={(emoji) => {
          if (reactFor) reactWith(reactFor, emoji);
          setReactFor(null);
        }}
        onClose={() => setReactFor(null)}
      />
      {profileFor ? (
        <ProfileSheet message={profileFor} onClose={() => setProfileFor(null)} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerBtns: { flexDirection: "row", gap: 16 },
  headerBtnOff: { opacity: 0.35 },
  headerTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  headerChan: { color: colors.dim },
  rootMsg: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderStrong,
    paddingBottom: 8,
    marginBottom: 8,
    paddingTop: 8,
  },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 24 },
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
  sheetBtn: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 13 },
  sheetText: { color: colors.text, fontSize: 15.5 },
  sheetDanger: { color: colors.red },
});
