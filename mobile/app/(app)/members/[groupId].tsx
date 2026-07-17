/* Group members, mirroring the desktop members pane: people and agents in
   sections, channel-scope shown by name, live/offline status, an add-agent
   flow with a "whole group / one channel" scope picker, and (for group
   admins) an add-person flow with a member/admin role picker plus
   promote/demote. Anyone can leave a group themselves. */

import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Link, Stack, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, User } from "lucide-react-native";
import {
  useAddMember,
  useAgents,
  useGroups,
  useMembers,
  useRemoveMember,
  useUsers,
} from "../../../src/api/queries";
import type { AgentInfo, Member, UserInfo } from "../../../src/api/types";
import { AgentAvatar } from "../../../src/components/AgentAvatar";
import { ArmedButton } from "../../../src/components/ArmedButton";
import { Icon } from "../../../src/components/Icon";
import { toast, toastErr } from "../../../src/components/Toast";
import { colors } from "../../../src/lib/theme";
import { useSession } from "../../../src/state/session";

function LiveDot({ live }: { live: boolean }) {
  return <View style={[styles.dot, { backgroundColor: live ? colors.green : colors.faint }]} />;
}

function MemberRow({
  member,
  channelName,
  offline,
  admin,
  isSelf,
  onRemove,
  onSetRole,
}: {
  member: Member;
  channelName: string | null;
  offline: boolean;
  admin: boolean;
  isSelf?: boolean;
  onRemove: () => void;
  /** Group admins only, user members only: flip member/admin. */
  onSetRole?: (role: "admin" | "member") => void;
}) {
  return (
    <View style={styles.row}>
      {member.member_type === "agent" ? (
        <AgentAvatar agentId={member.member_id} size={26} />
      ) : (
        <Icon icon={User} size={20} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>
          {member.name || member.member_id}
          {isSelf ? <Text style={styles.meta}> (you)</Text> : null}
        </Text>
        <Text style={styles.meta}>
          {member.role}
          {channelName ? ` · scoped to #${channelName}` : ""}
          {offline ? <Text style={styles.offline}> · offline — won't reply</Text> : null}
        </Text>
      </View>
      {onSetRole ? (
        <Pressable
          style={styles.roleBtn}
          onPress={() => onSetRole(member.role === "admin" ? "member" : "admin")}
        >
          <Text style={styles.roleBtnText}>
            {member.role === "admin" ? "Demote" : "Make admin"}
          </Text>
        </Pressable>
      ) : null}
      {admin || isSelf ? (
        <ArmedButton label={isSelf ? "Leave" : "Remove"} onConfirm={onRemove} />
      ) : null}
    </View>
  );
}

/* Two-step add flow: pick an agent, then pick its scope. */
function AddAgent({
  agents,
  channels,
  pending,
  onAdd,
  onCancel,
}: {
  agents: AgentInfo[];
  channels: { id: string; name: string }[];
  pending: boolean;
  onAdd: (agent: AgentInfo, channelId: string | null) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<AgentInfo | null>(null);

  if (!picked) {
    return (
      <View style={styles.addBox}>
        <Text style={styles.addTitle}>Pick an agent</Text>
        {agents.map((a) => (
          <Pressable key={a.id} style={styles.row} onPress={() => setPicked(a)}>
            <AgentAvatar agentId={a.id} size={26} />
            <LiveDot live={a.live} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{a.name}</Text>
              <Text style={styles.meta}>{a.live ? "online" : "offline"}</Text>
            </View>
            <Icon icon={ChevronRight} size={17} color={colors.faint} />
          </Pressable>
        ))}
        {agents.length === 0 ? (
          <Text style={styles.hint}>
            No agents yet. Link a Pantheo instance or pair a bridge under{" "}
            <Link href="/(app)/agents" style={styles.hintLink}>
              Agents
            </Link>{" "}
            first.
          </Text>
        ) : null}
        <Pressable style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.addBox}>
      <Text style={styles.addTitle}>
        Where should <Text style={styles.name}>{picked.name}</Text> listen?
      </Text>
      <Text style={styles.hint}>Scope it to one channel, or give it the whole group.</Text>
      <View style={styles.scopeChips}>
        <Pressable
          style={styles.scopeChip}
          disabled={pending}
          onPress={() => onAdd(picked, null)}
        >
          <Text style={styles.scopeText}>Whole group</Text>
        </Pressable>
        {channels.map((c) => (
          <Pressable
            key={c.id}
            style={styles.scopeChip}
            disabled={pending}
            onPress={() => onAdd(picked, c.id)}
          >
            <Text style={styles.scopeText}># {c.name}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable style={styles.cancelBtn} onPress={() => setPicked(null)}>
        <View style={styles.cancelRow}>
          <Icon icon={ChevronLeft} size={15} />
          <Text style={styles.cancelText}>Back</Text>
        </View>
      </Pressable>
    </View>
  );
}

/* Two-step add flow: pick a workspace user, then a role. */
function AddPerson({
  users,
  pending,
  onAdd,
  onCancel,
}: {
  users: UserInfo[];
  pending: boolean;
  onAdd: (user: UserInfo, role: "admin" | "member") => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<UserInfo | null>(null);

  if (!picked) {
    return (
      <View style={styles.addBox}>
        <Text style={styles.addTitle}>Pick a person</Text>
        {users.map((u) => (
          <Pressable key={u.username} style={styles.row} onPress={() => setPicked(u)}>
            <Icon icon={User} size={20} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{u.display_name || u.username}</Text>
              <Text style={styles.meta}>{u.username}</Text>
            </View>
            <Icon icon={ChevronRight} size={17} color={colors.faint} />
          </Pressable>
        ))}
        {users.length === 0 ? (
          <Text style={styles.hint}>
            Everyone in the workspace is already in this group. Instance admins can
            invite new people from the web app.
          </Text>
        ) : null}
        <Pressable style={styles.cancelBtn} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.addBox}>
      <Text style={styles.addTitle}>
        Add <Text style={styles.name}>{picked.display_name || picked.username}</Text> as…
      </Text>
      <View style={styles.scopeChips}>
        <Pressable
          style={styles.scopeChip}
          disabled={pending}
          onPress={() => onAdd(picked, "member")}
        >
          <Text style={styles.scopeText}>Member</Text>
        </Pressable>
        <Pressable
          style={styles.scopeChip}
          disabled={pending}
          onPress={() => onAdd(picked, "admin")}
        >
          <Text style={styles.scopeText}>Group admin</Text>
        </Pressable>
      </View>
      <Pressable style={styles.cancelBtn} onPress={() => setPicked(null)}>
        <View style={styles.cancelRow}>
          <Icon icon={ChevronLeft} size={15} />
          <Text style={styles.cancelText}>Back</Text>
        </View>
      </Pressable>
    </View>
  );
}

export default function MembersScreen() {
  const params = useLocalSearchParams<{ groupId: string; name?: string }>();
  const groupId = params.groupId;
  const members = useMembers(groupId);
  const agents = useAgents();
  const groups = useGroups();
  const addMember = useAddMember(groupId);
  const removeMember = useRemoveMember(groupId);
  const [adding, setAdding] = useState(false);
  const [addingPerson, setAddingPerson] = useState(false);
  const username = useSession((s) => s.username);

  const group = useMemo(
    () => (groups.data ?? []).find((g) => g.id === groupId) ?? null,
    [groups.data, groupId],
  );
  const admin = group ? group.role === "admin" : true;
  // Only fetch the workspace roster when the picker can actually be used.
  const users = useUsers(admin);
  const channels = group?.channels ?? [];
  const channelName = (id: string | null) =>
    id ? (channels.find((c) => c.id === id)?.name ?? id) : null;
  const liveById = useMemo(
    () => new Map((agents.data ?? []).map((a) => [a.id, a.live])),
    [agents.data],
  );

  const people = (members.data ?? []).filter((m) => m.member_type === "user");
  const agentMembers = (members.data ?? []).filter((m) => m.member_type === "agent");

  /* Desktop lists every known agent in the picker (an agent can be scoped to
     several channels); only hide the ones that already listen group-wide. */
  const groupWide = new Set(
    agentMembers.filter((m) => !m.channel_id).map((m) => m.member_id),
  );
  const addable = (agents.data ?? []).filter((a) => !groupWide.has(a.id));

  const memberUsernames = new Set(people.map((m) => m.member_id));
  const addablePeople = (users.data ?? []).filter(
    (u) => !u.disabled && !memberUsernames.has(u.username),
  );

  const addPerson = (u: UserInfo, role: "admin" | "member") => {
    addMember.mutate(
      { member_type: "user", member_id: u.username, role },
      {
        onSuccess: () => {
          setAddingPerson(false);
          toast(`${u.display_name || u.username} added to the group.`);
        },
        onError: (e) => toastErr("Add failed", e),
      },
    );
  };

  // Re-adding with a new role upserts it server-side — that's promote/demote.
  const setRole = (m: Member, role: "admin" | "member") => {
    addMember.mutate(
      { member_type: "user", member_id: m.member_id, role, channel_id: m.channel_id ?? undefined },
      { onError: (e) => toastErr("Role change failed", e) },
    );
  };

  const add = (agent: AgentInfo, channelId: string | null) => {
    addMember.mutate(
      { member_type: "agent", member_id: agent.id, channel_id: channelId ?? undefined },
      {
        onSuccess: () => {
          setAdding(false);
          if (agent.live) {
            toast(`${agent.name} added — it will answer messages here.`);
          } else {
            toast(
              `${agent.name} joined, but it's offline right now — it will answer once its connection is live.`,
              "warn",
            );
          }
        },
        onError: (e) => toastErr("Add failed", e),
      },
    );
  };

  const remove = (m: Member) =>
    removeMember.mutate(
      { member_type: m.member_type, member_id: m.member_id, channel_id: m.channel_id },
      { onError: (e) => toastErr("Remove failed", e) },
    );

  return (
    <>
      <Stack.Screen
        options={{
          title: params.name || group?.name ? `${params.name || group?.name} · members` : "Members",
          headerShown: true,
        }}
      />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {people.length > 0 ? <Text style={styles.section}>People</Text> : null}
        {people.map((m) => (
          <MemberRow
            key={`user:${m.member_id}:${m.channel_id ?? ""}`}
            member={m}
            channelName={channelName(m.channel_id)}
            offline={false}
            admin={admin}
            isSelf={m.member_id === username}
            onRemove={() => remove(m)}
            onSetRole={
              admin && m.member_id !== username
                ? (role) => setRole(m, role)
                : undefined
            }
          />
        ))}
        {admin && !addingPerson ? (
          <Pressable style={styles.addBtn} onPress={() => setAddingPerson(true)}>
            <Text style={styles.addBtnText}>＋ Add person</Text>
          </Pressable>
        ) : null}
        {admin && addingPerson ? (
          <AddPerson
            users={addablePeople}
            pending={addMember.isPending}
            onAdd={addPerson}
            onCancel={() => setAddingPerson(false)}
          />
        ) : null}

        <Text style={styles.section}>Agents</Text>
        {agentMembers.map((m) => (
          <MemberRow
            key={`agent:${m.member_id}:${m.channel_id ?? ""}`}
            member={m}
            channelName={channelName(m.channel_id)}
            offline={liveById.get(m.member_id) === false}
            admin={admin}
            onRemove={() => remove(m)}
          />
        ))}
        {members.isSuccess && agentMembers.length === 0 ? (
          <Text style={styles.empty}>No agents in this group yet.</Text>
        ) : null}

        {admin && !adding ? (
          <Pressable style={styles.addBtn} onPress={() => setAdding(true)}>
            <Text style={styles.addBtnText}>＋ Add agent</Text>
          </Pressable>
        ) : null}
        {admin && adding ? (
          <AddAgent
            agents={addable}
            channels={channels}
            pending={addMember.isPending}
            onAdd={add}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {admin ? (
          <Text style={styles.hint}>
            Agents answer messages in the channels they listen to. Connect agents on the{" "}
            <Link href="/(app)/agents" style={styles.hintLink}>
              Agents
            </Link>{" "}
            page first.
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 8, paddingBottom: 40 },
  section: {
    color: colors.dim,
    fontSize: 11.5,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 8,
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  name: { color: colors.text, fontSize: 14.5, fontWeight: "600" },
  meta: { color: colors.dim, fontSize: 12 },
  offline: { color: colors.amber },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 14 },
  addBtn: { alignItems: "center", paddingVertical: 12 },
  addBtnText: { color: colors.a1, fontSize: 14.5, fontWeight: "700" },
  addBox: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 14,
    padding: 12,
    gap: 8,
    marginTop: 6,
  },
  addTitle: { color: colors.text, fontSize: 14.5, fontWeight: "700" },
  scopeChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  scopeChip: {
    backgroundColor: "rgba(139,124,255,0.15)",
    borderWidth: 1,
    borderColor: "rgba(139,124,255,0.3)",
    borderRadius: 9,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  scopeText: { color: colors.a1, fontSize: 13.5, fontWeight: "600" },
  cancelBtn: { alignItems: "center", paddingVertical: 8 },
  cancelRow: { flexDirection: "row", alignItems: "center", gap: 3 },
  cancelText: { color: colors.dim, fontSize: 13.5, fontWeight: "600" },
  roleBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  roleBtnText: { color: colors.a2, fontSize: 12.5, fontWeight: "700" },
  hint: { color: colors.faint, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 2 },
  hintLink: { color: colors.a2, textDecorationLine: "underline" },
});
