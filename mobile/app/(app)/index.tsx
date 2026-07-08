/* Home: groups with collapsible channel lists and unread badges — the
   mobile take on the desktop sidebar (drill-down instead of split pane). */

import React, { useMemo, useState } from "react";
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
} from "../../src/api/queries";
import type { Channel, Group } from "../../src/api/types";
import { ArmedButton } from "../../src/components/ArmedButton";
import { toastErr } from "../../src/components/Toast";
import { colors } from "../../src/lib/theme";

function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

function InlineCreate({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
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
        <Text style={styles.inlineOk}>{name.trim() ? "Add" : "Cancel"}</Text>
      </Pressable>
    </View>
  );
}

function ChannelRow({ group, channel }: { group: Group; channel: Channel }) {
  const [managing, setManaging] = useState(false);
  const deleteChannel = useDeleteChannel();
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
        <UnreadBadge count={channel.unread ?? 0} />
      </Pressable>
      {managing ? (
        <View style={styles.manageRow}>
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
    </View>
  );
}

function GroupCard({ group }: { group: Group }) {
  const [expanded, setExpanded] = useState(true);
  const [managing, setManaging] = useState(false);
  const [creating, setCreating] = useState(false);
  const createChannel = useCreateChannel();
  const deleteGroup = useDeleteGroup();
  const unread = group.channels.reduce((n, c) => n + (c.unread ?? 0), 0);

  return (
    <View style={styles.groupCard}>
      <Pressable
        style={styles.groupHead}
        onPress={() => setExpanded((e) => !e)}
        onLongPress={() => setManaging((m) => !m)}
      >
        <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text>
        <Text style={styles.groupName} numberOfLines={1}>
          {group.name}
        </Text>
        {!expanded ? <UnreadBadge count={unread} /> : null}
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
        ? group.channels.map((c) => <ChannelRow key={c.id} group={group} channel={c} />)
        : null}
      {expanded && group.channels.length === 0 ? (
        <Text style={styles.emptyChannels}>No channels yet — tap ＋</Text>
      ) : null}
    </View>
  );
}

export default function Home() {
  const groups = useGroups();
  const createGroup = useCreateGroup();
  const [creatingGroup, setCreatingGroup] = useState(false);

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
            onRefresh={() => void groups.refetch()}
            tintColor={colors.dim}
          />
        }
      >
        {(groups.data ?? []).map((g) => (
          <GroupCard key={g.id} group={g} />
        ))}
        {groups.isSuccess && groups.data.length === 0 ? (
          <Text style={styles.empty}>No groups yet. Create one to get started.</Text>
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
    backgroundColor: colors.accent,
    borderRadius: 9,
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: "center",
  },
  badgeText: { color: colors.onAccent, fontSize: 11.5, fontWeight: "800" },
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
