/* Home: groups with collapsible channel lists and unread badges — the
   mobile take on the desktop sidebar (drill-down instead of split pane).
   Red badges mean @you; muted badges are plain traffic (Slack convention).
   The Threads row is the inbox entry; the filter chip hides read channels.
   Long-press a group or channel name for manage/delete actions. */

import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
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
  Bot,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  MessagesSquare,
  Search,
  Settings,
} from "lucide-react-native";
import {
  useCreateChannel,
  useCreateGroup,
  useDeleteChannel,
  useDeleteGroup,
  useGroups,
  useSetGroupHidden,
  useThreads,
  useUpdateChannel,
} from "../../src/api/queries";
import type { Channel, Group } from "../../src/api/types";
import { Icon } from "../../src/components/Icon";
import { toastErr } from "../../src/components/Toast";
import { headerActions } from "../../src/lib/headerItems";
import { totalThreadUnread } from "../../src/lib/unread";
import { colors } from "../../src/lib/theme";
import { usePrefs } from "../../src/state/prefs";

function isGroupAdmin(group: Group): boolean {
  return group.role === "admin";
}

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
  const admin = isGroupAdmin(group);

  const confirmDelete = () => {
    Alert.alert(
      `Delete #${channel.name}?`,
      "This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteChannel.mutate(
              { groupId: group.id, channelId: channel.id },
              { onError: (e) => toastErr("Delete failed", e) },
            ),
        },
      ],
    );
  };

  const onLongPress = () => {
    if (!admin) return;
    const buttons: {
      text: string;
      style?: "cancel" | "destructive" | "default";
      onPress?: () => void;
    }[] = [
      { text: "Rename", onPress: () => { setManaging(true); setEditing("name"); } },
      { text: "Edit topic", onPress: () => { setManaging(true); setEditing("topic"); } },
      {
        text: "Hide channel",
        onPress: () =>
          updateChannel.mutate(
            { groupId: group.id, channelId: channel.id, hidden: true },
            { onError: (e) => toastErr("Hide failed", e) },
          ),
      },
      { text: "Delete channel", style: "destructive", onPress: confirmDelete },
      { text: "Cancel", style: "cancel" },
    ];
    Alert.alert(`#${channel.name}`, "Hiding tucks it into the Hidden section; nothing is deleted.", buttons);
  };

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
        onLongPress={onLongPress}
        delayLongPress={350}
      >
        <Text style={styles.hash}>#</Text>
        <Text style={styles.channelName} numberOfLines={1}>
          {channel.name}
        </Text>
        <UnreadBadge count={channel.unread ?? 0} mentions={channel.mentions ?? 0} />
      </Pressable>
      {managing && editing ? (
        <InlineCreate
          placeholder={editing === "name" ? "channel name" : "topic"}
          initial={editing === "name" ? channel.name : channel.topic}
          submitLabel="Save"
          onCancel={() => {
            setEditing(null);
            setManaging(false);
          }}
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
  const [creating, setCreating] = useState(false);
  const createChannel = useCreateChannel();
  const deleteGroup = useDeleteGroup();
  const setGroupHidden = useSetGroupHidden();
  const admin = isGroupAdmin(group);
  // Hidden channels live in the Hidden section and don't feed the badges.
  const shownChannels = group.channels.filter((c) => !c.hidden);
  const unread = shownChannels.reduce((n, c) => n + (c.unread ?? 0), 0);
  const mentions = shownChannels.reduce((n, c) => n + (c.mentions ?? 0), 0);
  const expanded = !collapsed;
  const visibleChannels = unreadsOnly
    ? shownChannels.filter((c) => (c.unread ?? 0) > 0 || (c.mentions ?? 0) > 0)
    : shownChannels;

  const confirmDelete = () => {
    Alert.alert(
      `Delete ${group.name}?`,
      "This deletes the group and everything in it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteGroup.mutate(group.id, {
              onError: (e) => toastErr("Delete failed", e),
            }),
        },
      ],
    );
  };

  const onLongPress = () => {
    const buttons: {
      text: string;
      style?: "cancel" | "destructive" | "default";
      onPress?: () => void;
    }[] = [
      {
        text: "Members",
        onPress: () =>
          router.push({
            pathname: "/(app)/members/[groupId]",
            params: { groupId: group.id, name: group.name },
          }),
      },
    ];
    if (admin) {
      buttons.push({
        text: "Hide group",
        onPress: () =>
          setGroupHidden.mutate(
            { groupId: group.id, hidden: true },
            { onError: (e) => toastErr("Hide failed", e) },
          ),
      });
      buttons.push({ text: "Delete group", style: "destructive", onPress: confirmDelete });
    }
    buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert(
      group.name,
      admin ? "Hiding tucks it into the Hidden section; nothing is deleted." : undefined,
      buttons,
    );
  };

  if (unreadsOnly && visibleChannels.length === 0) return null;

  return (
    <View style={styles.groupCard}>
      <Pressable
        style={styles.groupHead}
        onPress={() => toggleGroup(group.id)}
        onLongPress={onLongPress}
        delayLongPress={350}
      >
        <View style={styles.chevron}>
          <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} color={colors.faint} />
        </View>
        <Text style={styles.groupName} numberOfLines={1}>
          {group.name}
        </Text>
        {!expanded ? <UnreadBadge count={unread} mentions={mentions} /> : null}
        <Pressable onPress={() => setCreating((c) => !c)} hitSlop={10} style={styles.plusBtn}>
          <Text style={styles.plus}>＋</Text>
        </Pressable>
      </Pressable>
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

/* Collapsed drawer of hidden groups/channels at the bottom of the home list:
   they stay reachable (tap to open) and restorable (tap the eye) without
   crowding the main list. */
function HiddenSection({ groups }: { groups: Group[] }) {
  const [open, setOpen] = useState(false);
  const setGroupHidden = useSetGroupHidden();
  const updateChannel = useUpdateChannel();
  const hiddenGroups = groups.filter((g) => g.hidden);
  const hiddenChannels = groups
    .filter((g) => !g.hidden)
    .flatMap((g) => g.channels.filter((c) => c.hidden).map((c) => ({ group: g, channel: c })));
  const count = hiddenGroups.length + hiddenChannels.length;
  if (!count) return null;
  return (
    <View style={styles.hiddenCard}>
      <Pressable style={styles.hiddenHead} onPress={() => setOpen((o) => !o)}>
        <View style={styles.chevron}>
          <Icon icon={open ? ChevronDown : ChevronRight} size={14} color={colors.faint} />
        </View>
        <Icon icon={EyeOff} size={14} color={colors.faint} />
        <Text style={styles.hiddenTitle}>Hidden</Text>
        <Text style={styles.hiddenCount}>{count}</Text>
      </Pressable>
      {open
        ? hiddenGroups.map((g) => (
            <View key={g.id} style={styles.hiddenRow}>
              <Text style={styles.hiddenName} numberOfLines={1}>
                {g.name}
              </Text>
              {isGroupAdmin(g) ? (
                <Pressable
                  hitSlop={10}
                  onPress={() =>
                    setGroupHidden.mutate(
                      { groupId: g.id, hidden: false },
                      { onError: (e) => toastErr("Show failed", e) },
                    )
                  }
                >
                  <Icon icon={Eye} size={17} color={colors.a1} />
                </Pressable>
              ) : null}
            </View>
          ))
        : null}
      {open
        ? hiddenChannels.map(({ group, channel }) => (
            <View key={channel.id} style={styles.hiddenRow}>
              <Pressable
                style={styles.hiddenChanBtn}
                onPress={() =>
                  router.push({
                    pathname: "/(app)/channel/[id]",
                    params: { id: channel.id, name: channel.name, groupId: group.id },
                  })
                }
              >
                <Text style={styles.hiddenName} numberOfLines={1}>
                  <Text style={styles.hash}># </Text>
                  {channel.name}
                  <Text style={styles.hiddenGroupSuffix}> · {group.name}</Text>
                </Text>
              </Pressable>
              {isGroupAdmin(group) ? (
                <Pressable
                  hitSlop={10}
                  onPress={() =>
                    updateChannel.mutate(
                      { groupId: group.id, channelId: channel.id, hidden: false },
                      { onError: (e) => toastErr("Show failed", e) },
                    )
                  }
                >
                  <Icon icon={Eye} size={17} color={colors.a1} />
                </Pressable>
              ) : null}
            </View>
          ))
        : null}
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
      ...headerActions(
        <View style={styles.headerBtns}>
          <Link href="/(app)/search" asChild>
            <Pressable hitSlop={8}>
              <Icon icon={Search} size={21} color={colors.text} />
            </Pressable>
          </Link>
          <Link href="/(app)/agents" asChild>
            <Pressable hitSlop={8}>
              <Icon icon={Bot} size={21} color={colors.text} />
            </Pressable>
          </Link>
          <Link href="/(app)/settings" asChild>
            <Pressable hitSlop={8}>
              <Icon icon={Settings} size={21} color={colors.text} />
            </Pressable>
          </Link>
        </View>,
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
            <Icon icon={MessagesSquare} size={17} color={colors.a1} />
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
        {(groups.data ?? [])
          .filter((g) => !g.hidden)
          .map((g) => (
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
        <HiddenSection groups={groups.data ?? []} />
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
  chevron: { width: 14, alignItems: "center" },
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
  hiddenCard: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: 14,
    paddingVertical: 6,
  },
  hiddenHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  hiddenTitle: { color: colors.dim, fontSize: 13.5, fontWeight: "700", flex: 1 },
  hiddenCount: {
    color: colors.faint,
    fontSize: 11.5,
    fontWeight: "800",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 9,
    minWidth: 20,
    textAlign: "center",
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: "hidden",
  },
  hiddenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 34,
    paddingRight: 14,
    paddingVertical: 9,
  },
  hiddenChanBtn: { flex: 1 },
  hiddenName: { color: colors.dim, fontSize: 14, flex: 1 },
  hiddenGroupSuffix: { color: colors.faint, fontSize: 12.5 },
});
