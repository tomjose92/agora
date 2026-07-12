/* Unreads: every unread message across channels and threads in one place,
   bucketed by the conversation it came from (a channel's top level or one
   thread), newest conversation first. Tapping a card opens the channel or
   thread, which marks it read the normal way. */

import React, { useMemo } from "react";
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
import { CircleDot, CornerDownRight } from "lucide-react-native";
import { useUnreads } from "../../src/api/queries";
import type { UnreadMessage } from "../../src/api/types";
import { Icon } from "../../src/components/Icon";
import { fmtTs } from "../../src/lib/format";
import { colors } from "../../src/lib/theme";

interface Bucket {
  key: string;
  isThread: boolean;
  first: UnreadMessage;
  /** Oldest-first, like reading the room. */
  items: UnreadMessage[];
}

/** Group the flat newest-first list by conversation. */
function bucketize(unreads: UnreadMessage[]): Bucket[] {
  const byKey = new Map<string, Bucket>();
  for (const m of unreads) {
    const key = m.thread_id != null ? `t:${m.thread_id}` : `c:${m.channel_id}`;
    let b = byKey.get(key);
    if (!b) {
      b = { key, isThread: m.thread_id != null, first: m, items: [] };
      byKey.set(key, b);
    }
    b.items.unshift(m);
  }
  return [...byKey.values()];
}

function snippet(m: UnreadMessage): string {
  const text = m.text.replace(/\s+/g, " ").trim();
  return text || "(attachment)";
}

/** Label for a thread bucket: the root's alias, else its first line. */
function threadLabel(m: UnreadMessage): string {
  const alias = (m.root_alias ?? "").trim();
  if (alias) return alias;
  return (m.root_text ?? "").split("\n")[0].slice(0, 140) || "(thread)";
}

function Card({ bucket }: { bucket: Bucket }) {
  const { first, isThread, items } = bucket;
  const open = () =>
    isThread
      ? router.push({
          pathname: "/(app)/thread/[channelId]/[rootId]",
          params: {
            channelId: first.channel_id,
            rootId: String(first.thread_id),
            channelName: first.channel_name,
          },
        })
      : router.push({
          pathname: "/(app)/channel/[id]",
          params: { id: first.channel_id, name: first.channel_name, groupId: first.group_id },
        });
  return (
    <Pressable style={styles.card} onPress={open}>
      <View style={styles.top}>
        {isThread ? (
          <View style={styles.titleRow}>
            <Icon icon={CornerDownRight} size={13} color={colors.faint} />
            <Text style={styles.title} numberOfLines={1}>
              {threadLabel(first)}
              <Text style={styles.grp}>
                {" "}· #{first.channel_name} · {first.group_name}
              </Text>
            </Text>
          </View>
        ) : (
          <Text style={[styles.title, styles.titleFlex]} numberOfLines={1}>
            <Text style={styles.hash}># </Text>
            {first.channel_name}
            <Text style={styles.grp}> · {first.group_name}</Text>
          </Text>
        )}
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {items.length > 99 ? "99+" : items.length}
          </Text>
        </View>
      </View>
      {items.map((m) => (
        <View key={m.id} style={styles.msg}>
          <Text style={styles.author} numberOfLines={1}>
            {m.author_name || m.author_id}
          </Text>
          <Text style={styles.snippet} numberOfLines={1}>
            {snippet(m)}
          </Text>
          <Text style={styles.ts}>{fmtTs(m.ts)}</Text>
        </View>
      ))}
    </Pressable>
  );
}

export default function UnreadsScreen() {
  const unreads = useUnreads();
  const buckets = useMemo(() => bucketize(unreads.data ?? []), [unreads.data]);
  return (
    <>
      <Stack.Screen options={{ title: "Unreads", headerShown: true }} />
      <FlatList
        style={styles.root}
        contentContainerStyle={styles.content}
        data={buckets}
        keyExtractor={(b) => b.key}
        renderItem={({ item }) => <Card bucket={item} />}
        refreshControl={
          <RefreshControl
            refreshing={unreads.isRefetching}
            onRefresh={() => void unreads.refetch()}
            tintColor={colors.dim}
          />
        }
        ListEmptyComponent={
          unreads.isLoading ? (
            <ActivityIndicator color={colors.dim} style={{ paddingVertical: 40 }} />
          ) : (
            <View style={styles.empty}>
              <Icon icon={CircleDot} size={34} color={colors.faint} />
              <Text style={styles.emptyText}>All caught up</Text>
              <Text style={styles.emptyHint}>
                Unread messages from channels and the threads you're part of
                collect here.
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
  card: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: "rgba(139,124,255,0.45)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 5,
  },
  top: { flexDirection: "row", alignItems: "center", gap: 10 },
  titleRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  title: { color: colors.text, fontSize: 12.5, fontWeight: "700", flexShrink: 1 },
  titleFlex: { flex: 1 },
  hash: { color: colors.faint },
  grp: { color: colors.faint, fontWeight: "400" },
  badge: {
    backgroundColor: "rgba(139,124,255,0.35)",
    borderRadius: 9,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: "center",
  },
  badgeText: { color: colors.text, fontSize: 11.5, fontWeight: "800" },
  msg: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  author: { color: colors.a1, fontSize: 13, fontWeight: "700", flexShrink: 0 },
  snippet: { color: colors.dim, fontSize: 13.5, flex: 1 },
  ts: { color: colors.faint, fontSize: 11, flexShrink: 0 },
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
