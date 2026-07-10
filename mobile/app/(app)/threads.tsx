/* Threads inbox: every thread you started or replied in, newest activity
   first, with per-thread unread badges — the mobile take on Slack's
   "Threads" view. Tapping a row opens the thread screen directly. */

import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router } from "expo-router";
import { MessagesSquare } from "lucide-react-native";
import { useThreads } from "../../src/api/queries";
import type { ThreadRow } from "../../src/api/types";
import { Icon } from "../../src/components/Icon";
import { fmtTs } from "../../src/lib/format";
import { colors } from "../../src/lib/theme";

function snippet(t: ThreadRow): string {
  const text = t.root.text.replace(/\s+/g, " ").trim();
  return text || "(attachment)";
}

function Row({ thread }: { thread: ThreadRow }) {
  return (
    <Pressable
      style={[styles.row, thread.unread > 0 ? styles.rowUnread : null]}
      onPress={() =>
        router.push({
          pathname: "/(app)/thread/[channelId]/[rootId]",
          params: {
            channelId: thread.channel_id,
            rootId: String(thread.root.id),
            channelName: thread.channel_name,
          },
        })
      }
    >
      <View style={styles.top}>
        <Text style={styles.chan} numberOfLines={1}>
          <Text style={styles.hash}># </Text>
          {thread.channel_name}
          <Text style={styles.grp}> · {thread.group_name}</Text>
        </Text>
        <Text style={styles.ts}>{fmtTs(thread.last_reply_ts)}</Text>
      </View>
      <View style={styles.mid}>
        <Text style={styles.author} numberOfLines={1}>
          {thread.root.author_name || thread.root.author_id}
        </Text>
        <Text style={styles.snippet} numberOfLines={1}>
          {snippet(thread)}
        </Text>
      </View>
      <View style={styles.foot}>
        <Text style={styles.replies}>
          {thread.reply_count} {thread.reply_count === 1 ? "reply" : "replies"}
        </Text>
        {thread.unread > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {thread.unread > 99 ? "99+" : thread.unread}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function ThreadsScreen() {
  const threads = useThreads();
  return (
    <>
      <Stack.Screen options={{ title: "Threads", headerShown: true }} />
      <FlatList
        style={styles.root}
        contentContainerStyle={styles.content}
        data={threads.data ?? []}
        keyExtractor={(t) => String(t.root.id)}
        renderItem={({ item }) => <Row thread={item} />}
        refreshControl={
          <RefreshControl
            refreshing={threads.isRefetching}
            onRefresh={() => void threads.refetch()}
            tintColor={colors.dim}
          />
        }
        ListEmptyComponent={
          threads.isLoading ? (
            <ActivityIndicator color={colors.dim} style={{ paddingVertical: 40 }} />
          ) : (
            <View style={styles.empty}>
              <Icon icon={MessagesSquare} size={34} color={colors.faint} />
              <Text style={styles.emptyText}>No threads yet</Text>
              <Text style={styles.emptyHint}>
                Threads you start or reply in show up here, with unread counts
                as replies land.
              </Text>
            </View>
          )
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 10, paddingBottom: 40 },
  row: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 4,
  },
  rowUnread: { borderColor: "rgba(139,124,255,0.45)" },
  top: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  chan: { color: colors.text, fontSize: 12.5, fontWeight: "700", flex: 1 },
  hash: { color: colors.faint },
  grp: { color: colors.faint, fontWeight: "400" },
  ts: { color: colors.faint, fontSize: 11 },
  mid: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { color: colors.a1, fontSize: 13, fontWeight: "700", flexShrink: 0 },
  snippet: { color: colors.dim, fontSize: 13.5, flex: 1 },
  foot: { flexDirection: "row", alignItems: "center", gap: 10 },
  replies: { color: colors.faint, fontSize: 11.5 },
  badge: {
    backgroundColor: "rgba(139,124,255,0.35)",
    borderRadius: 9,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: "center",
  },
  badgeText: { color: colors.text, fontSize: 11.5, fontWeight: "800" },
  empty: { alignItems: "center", paddingVertical: 60, gap: 6 },
  emptyText: { color: colors.dim, fontSize: 15, fontWeight: "600" },
  emptyHint: {
    color: colors.faint,
    fontSize: 12.5,
    textAlign: "center",
    paddingHorizontal: 40,
    lineHeight: 18,
  },
});
