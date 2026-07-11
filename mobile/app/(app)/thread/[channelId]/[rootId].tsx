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
import { Headphones, Star, Volume2 } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../../../src/api/keys";
import {
  flattenMessages,
  useChannelAgents,
  useGroups,
  useMarkThreadRead,
  useMembers,
  useMessage,
  useMessages,
  useSendMessage,
  useSendVoice,
  useStarMessage,
  useStars,
} from "../../../../src/api/queries";
import type { Message, ThreadRow } from "../../../../src/api/types";
import { Composer, type MentionCandidate } from "../../../../src/components/Composer";
import { Icon } from "../../../../src/components/Icon";
import { ProgressBubbles, TypingRow } from "../../../../src/components/LiveRows";
import { MessageItem } from "../../../../src/components/MessageItem";
import { toastErr } from "../../../../src/components/Toast";
import { onAgentMessage } from "../../../../src/lib/agentBus";
import { useHeaderKeyboardOffset } from "../../../../src/lib/keyboard";
import {
  enqueueSpeech,
  prepareSpeechAudio,
  stopSpeech,
} from "../../../../src/lib/speech";
import { colors } from "../../../../src/lib/theme";
import { threadAddressKey } from "../../../../src/state/addressed";
import { useChannelLive } from "../../../../src/state/live";
import { usePrefs } from "../../../../src/state/prefs";
import { useSession } from "../../../../src/state/session";

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
  const groupId = useMemo(() => {
    for (const g of groups.data ?? []) {
      if (g.channels.some((c) => c.id === channelId)) return g.id;
    }
    return null;
  }, [groups.data, channelId]);
  const members = useMembers(groupId ?? "");

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
        />
      </View>
    ),
    [session, starredIds],
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: params.channelName ? `Thread · # ${params.channelName}` : "Thread",
          headerShown: true,
          headerRight: () =>
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
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.15,
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
          ListHeaderComponent={
            replies.isFetchingNextPage ? (
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
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  headerBtns: { flexDirection: "row", gap: 16 },
  headerBtnOff: { opacity: 0.35 },
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
});
