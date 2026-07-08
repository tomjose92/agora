/* Thread view: the root message pinned at the top, replies below, and a
   composer that posts with thread_id (the server folds reply-to-reply back
   to the root, same as resolve_thread in server.rs). */

import React, { useMemo } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  flattenMessages,
  useChannelAgents,
  useMessages,
  useSendMessage,
} from "../../../../src/api/queries";
import { Composer } from "../../../../src/components/Composer";
import { ProgressBubbles, TypingRow } from "../../../../src/components/LiveRows";
import { MessageItem } from "../../../../src/components/MessageItem";
import { colors } from "../../../../src/lib/theme";
import { useChannelLive } from "../../../../src/state/live";
import { useSession } from "../../../../src/state/session";

export default function ThreadScreen() {
  const params = useLocalSearchParams<{
    channelId: string;
    rootId: string;
    channelName?: string;
  }>();
  const channelId = params.channelId;
  const rootId = Number(params.rootId);
  const session = useSession((s) => s.session)!;

  const replies = useMessages(channelId, rootId);
  const topLevel = useMessages(channelId, null);
  const send = useSendMessage(channelId);
  const channelAgents = useChannelAgents(channelId);
  const { typing, progress } = useChannelLive(channelId, rootId);

  // The root usually sits in the already-loaded top-level page set.
  const root = useMemo(
    () => flattenMessages(topLevel.data).find((m) => m.id === rootId) ?? null,
    [topLevel.data, rootId],
  );
  const thread = useMemo(() => flattenMessages(replies.data), [replies.data]);

  return (
    <>
      <Stack.Screen
        options={{
          title: params.channelName ? `Thread · # ${params.channelName}` : "Thread",
          headerShown: true,
        }}
      />
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          {root ? (
            <View style={styles.rootMsg}>
              <MessageItem session={session} message={root} />
            </View>
          ) : null}
          {replies.isLoading ? (
            <ActivityIndicator color={colors.dim} style={{ paddingVertical: 24 }} />
          ) : null}
          {!replies.isLoading && thread.length === 0 ? (
            <Text style={styles.empty}>No replies yet.</Text>
          ) : null}
          {thread.map((m) => (
            <MessageItem key={m.id} session={session} message={m} />
          ))}
        </ScrollView>
        <TypingRow typing={typing} />
        <ProgressBubbles progress={progress} />
        <Composer
          placeholder="Reply in thread"
          mentions={(channelAgents.data ?? []).map((a) => ({ id: a.id, name: a.name }))}
          sending={send.isPending}
          onSend={async ({ text, files }) => {
            await send.mutateAsync({ text, threadId: rootId, files });
          }}
        />
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingVertical: 8 },
  rootMsg: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderStrong,
    paddingBottom: 8,
    marginBottom: 8,
  },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 24 },
});
