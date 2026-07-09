/* Home: groups with collapsible channel lists and unread badges — the
   mobile take on the desktop sidebar (drill-down instead of split pane).
   Red badges mean @you; muted badges are plain traffic (Slack convention).
   The Threads row is the inbox entry; the filter chip hides read channels. */

import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Link, Stack, router } from "expo-router";
import {
  useCreateChannel,
  useCreateGroup,
  useDeleteChannel,
  useDeleteGroup,
  useGroups,
  useThreads,
  useUpdateChannel,
} from "../../src/api/queries";
import type { Channel, Group } from "../../src/api/types";
import { ArmedButton } from "../../src/components/ArmedButton";
import { toastErr } from "../../src/components/Toast";
import { totalThreadUnread } from "../../src/lib/unread";
import { colors } from "../../src/lib/theme";
import { usePrefs } from "../../src/state/prefs";

export function UnreadBadge({
  count,
  mentions = 0,
}: {
  count: number;
  mentions?: number;
}) {
  if (mentions > 0) {
    return (
      <View style={[styles.badge, styles.badgeMention]}>
        <Text style={styles.badgeMentionText}>@ {mentions > 99 ? "99+" : mentions}</Text>
      </View>
    );
  }
  if (!count) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

function InlineCreate({
  placeholder,
  initial = "",
  submitLabel = "Add",
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  initial?: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <View style={styles.inlineCreate}>
      <TextInput
        style={styles.inlineInput}
        value={name}
        onChangeText={setName}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        autoFocus
        autoCapitalize="none"
        onSubmitEditing={() => name.trim() && onSubmit(name.trim())}
      />
      <Pressable onPress={() => (name.trim() ? onSubmit(name.trim()) : onCancel())} hitSlop={8}>
        <Text style={styles.inlineOk}>{name.trim() ? submitLabel : "Cancel"}</Text>
      </Pressable>
    </View>
  );
}

function ChannelRow({ group, channel }: { group: Group; channel: Channel }) {
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<"name" | "topic" | null>(null);
  const deleteChannel = useDeleteChannel();
  const updateChannel = useUpdateChannel();
  return (
    <View>
      <Pressable
        style={styles.channelRow}
        onPress={() =>
          router.push({
            pathname: "/(app)/channel/[id]",
            params: { id: channel.id, name: channel.name, groupId: group.id },
          })
        }
        onLongPress={() => setManaging((m) => !m)}
      >
        <Text style={styles.hash}>#</Text>
        <Text style={styles.channelName} numberOfLines={1}>
          {channel.name}
        </Text>
        <UnreadBadge count={channel.unread ?? 0} mentions={channel.mentions ?? 0} />
      </Pressable>
      {managing && !editing ? (
        <View style={styles.manageRow}>
          <Pressable style={styles.manageBtn} onPress={() => setEditing("name")}>
            <Text style={styles.manageBtnText}>Rename</Text>
          </Pressable>
          <Pressable style={styles.manageBtn} onPress={() => setEditing("topic")}>
            <Text style={styles.manageBtnText}>Topic</Text>
          </Pressable>
          <ArmedButton
            label="Delete channel"
            onConfirm={() =>
              deleteChannel.mutate(
                { groupId: group.id, channelId: channel.id },
                { onError: (e) => toastErr("Delete failed", e), onSettled: () => setManaging(false) },
              )
            }
          />
        </View>
      ) : null}
      {editing ? (
        <InlineCreate
          placeholder={editing === "name" ? "channel name" : "topic"}
          initial={editing === "name" ? channel.name : channel.topic}
          submitLabel="Save"
          onCancel={() => setEditing(null)}
          onSubmit={(value) =>
            updateChannel.mutate(
              {
                groupId: group.id,
                channelId: channel.id,
                ...(editing === "name" ? { name: value } : { topic: value }),
              },
              {
                onSuccess: () => {
                  setEditing(null);
                  setManaging(false);
                },
                onError: (e) => toastErr("Update failed", e),
              },
            )
          }
        />
      ) : null}
    </View>
  );
}

function GroupCard({ group, unreadsOnly }: { group: Group; unreadsOnly: boolean }) {
  const collapsed = usePrefs((s) => !!s.collapsedGroups[group.id]);
  const toggleGroup = usePrefs((s) => s.toggleGroup);
  const [managing, setManaging] = useState(false);
  const [creating, setCreating] = useState(false);
  const createChannel = useCreateChannel();
  const deleteGroup = useDeleteGroup();
  const unread = group.channels.reduce((n, c) => n + (c.unread ?? 0), 0);
  const mentions = group.channels.reduce((n, c) => n + (c.mentions ?? 0), 0);
  const expanded = !collapsed;
  const visibleChannels = unreadsOnly
    ? group.channels.filter((c) => (c.unread ?? 0) > 0 || (c.mentions ?? 0) > 0)
    : group.channels;

  if (unreadsOnly && visibleChannels.length === 0) return null;

  return (
    <View style={styles.groupCard}>
      <Pressable
        style={styles.groupHead}
        onPress={() => toggleGroup(group.id)}
        onLongPress={() => setManaging((m) => !m)}
      >
        <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
        <Text style={styles.groupName} numberOfLines={1}>
          {group.name}
        </Text>
        {!expanded ? <UnreadBadge count={unread} mentions={mentions} /> : null}
        <Pressable onPress={() => setCreating((c) => !c)} hitSlop={10} style={styles.plusBtn}>
          <Text style={styles.plus}>＋</Text>
        </Pressable>
      </Pressable>
      {managing ? (
        <View style={styles.manageRow}>
          <Link
            href={{ pathname: "/(app)/members/[groupId]", params: { groupId: group.id, name: group.name } }}
            asChild
          >
            <Pressable style={styles.manageBtn}>
              <Text style={styles.manageBtnText}>Members</Text>
            </Pressable>
          </Link>
          <ArmedButton
            label="Delete group"
            onConfirm={() =>
              deleteGroup.mutate(group.id, {
                onError: (e) => toastErr("Delete failed", e),
                onSettled: () => setManaging(false),
              })
            }
          />
        </View>
      ) : null}
      {creating ? (
        <InlineCreate
          placeholder="new channel name"
          onCancel={() => setCreating(false)}
          onSubmit={(name) =>
            createChannel.mutate(
              { groupId: group.id, name },
              {
                onSuccess: () => setCreating(false),
                onError: (e) => toastErr("Create failed", e),
              },
            )
          }
        />
      ) : null}
      {expanded
        ? visibleChannels.map((c) => <ChannelRow key={c.id} group={group} channel={c} />)
        : null}
      {expanded && group.channels.length === 0 ? (
        <Text style={styles.emptyChannels}>No channels yet — tap ＋</Text>
      ) : null}
    </View>
  );
}

export default function Home() {
  const groups = useGroups();
  const threads = useThreads();
  const createGroup = useCreateGroup();
  const [creatingGroup, setCreatingGroup] = useState(false);
  const prefsLoaded = usePrefs((s) => s.loaded);
  const loadPrefs = usePrefs((s) => s.load);
  const unreadsOnly = usePrefs((s) => s.unreadsOnly);
  const setUnreadsOnly = usePrefs((s) => s.setUnreadsOnly);
  useEffect(() => {
    if (!prefsLoaded) void loadPrefs();
  }, [prefsLoaded, loadPrefs]);

  const threadUnread = totalThreadUnread(threads.data ?? []);

  const header = useMemo(
    () => ({
      title: "Agora",
      headerShown: true,
      headerRight: () => (
        <View style={styles.headerBtns}>
          <Link href="/(app)/agents" asChild>
            <Pressable hitSlop={8}>
              <Text style={styles.headerBtn}>🤖</Text>
            </Pressable>
          </Link>
          <Link href="/(app)/settings" asChild>
            <Pressable hitSlop={8}>
              <Text style={styles.headerBtn}>⚙️</Text>
            </Pressable>
          </Link>
        </View>
      ),
    }),
    [],
  );

  return (
    <>
      <Stack.Screen options={header} />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={groups.isRefetching}
            onRefresh={() => {
              void groups.refetch();
              void threads.refetch();
            }}
            tintColor={colors.dim}
          />
        }
      >
        <View style={styles.topRow}>
          <Pressable
            style={styles.threadsRow}
            onPress={() => router.push("/(app)/threads")}
          >
            <Text style={styles.threadsIcon}>🧵</Text>
            <Text style={styles.threadsLabel}>Threads</Text>
            {threadUnread > 0 ? (
              <View style={[styles.badge, styles.badgeThread]}>
                <Text style={styles.badgeText}>
                  {threadUnread > 99 ? "99+" : threadUnread}
                </Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable
            style={[styles.filterChip, unreadsOnly ? styles.filterChipOn : null]}
            onPress={() => setUnreadsOnly(!unreadsOnly)}
            hitSlop={6}
          >
            <Text style={[styles.filterText, unreadsOnly ? styles.filterTextOn : null]}>
              Unreads
            </Text>
          </Pressable>
        </View>
        {(groups.data ?? []).map((g) => (
          <GroupCard key={g.id} group={g} unreadsOnly={unreadsOnly} />
        ))}
        {groups.isSuccess && groups.data.length === 0 ? (
          <Text style={styles.empty}>No groups yet. Create one to get started.</Text>
        ) : null}
        {groups.isSuccess && groups.data.length > 0 && unreadsOnly ? (
          <Text style={styles.filterHint}>Showing unread channels only.</Text>
        ) : null}
        {groups.isError ? (
          <Text style={styles.empty}>Couldn't load groups: {groups.error.message}</Text>
        ) : null}
        {creatingGroup ? (
          <InlineCreate
            placeholder="new group name"
            onCancel={() => setCreatingGroup(false)}
            onSubmit={(name) =>
              createGroup.mutate(
                { name },
                {
                  onSuccess: () => setCreatingGroup(false),
                  onError: (e) => toastErr("Create failed", e),
                },
              )
            }
          />
        ) : (
          <Pressable style={styles.newGroup} onPress={() => setCreatingGroup(true)}>
            <Text style={styles.newGroupText}>＋ New group</Text>
          </Pressable>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 12, paddingBottom: 40 },
  headerBtns: { flexDirection: "row", gap: 16 },
  headerBtn: { fontSize: 19 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  threadsRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  threadsIcon: { fontSize: 15 },
  threadsLabel: { color: colors.text, fontSize: 15, fontWeight: "700", flex: 1 },
  filterChip: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  filterChipOn: { backgroundColor: "rgba(139,124,255,0.16)", borderColor: colors.a1 },
  filterText: { color: colors.dim, fontSize: 12.5, fontWeight: "700" },
  filterTextOn: { color: colors.a1 },
  filterHint: { color: colors.faint, fontSize: 12, textAlign: "center" },
  groupCard: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingVertical: 6,
  },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chevron: { color: colors.faint, fontSize: 13, width: 14 },
  groupName: { color: colors.text, fontSize: 15.5, fontWeight: "700", flex: 1 },
  plusBtn: { paddingLeft: 8 },
  plus: { color: colors.dim, fontSize: 17 },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 34,
    paddingRight: 14,
    paddingVertical: 9,
  },
  hash: { color: colors.faint, fontSize: 14 },
  channelName: { color: colors.text, fontSize: 14.5, flex: 1 },
  badge: {
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: 9,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: "center",
  },
  badgeText: { color: colors.text, fontSize: 11.5, fontWeight: "800" },
  badgeMention: { backgroundColor: colors.red },
  badgeMentionText: { color: "#fff", fontSize: 11.5, fontWeight: "800" },
  badgeThread: { backgroundColor: "rgba(139,124,255,0.35)" },
  manageRow: {
    flexDirection: "row",
    gap: 10,
    paddingLeft: 34,
    paddingRight: 14,
    paddingVertical: 6,
    alignItems: "center",
  },
  manageBtn: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  manageBtnText: { color: colors.text, fontSize: 12.5, fontWeight: "600" },
  inlineCreate: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  inlineInput: {
    flex: 1,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
  },
  inlineOk: { color: colors.a2, fontSize: 13.5, fontWeight: "700" },
  emptyChannels: { color: colors.faint, fontSize: 13, paddingLeft: 34, paddingVertical: 8 },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 30, fontSize: 14 },
  newGroup: { alignItems: "center", paddingVertical: 12 },
  newGroupText: { color: colors.a1, fontSize: 14.5, fontWeight: "700" },
});
