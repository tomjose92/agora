/* Group members: people and agents, add an agent from the known-agents
   registry, remove with a two-step confirm. */

import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  useAddMember,
  useAgents,
  useMembers,
  useRemoveMember,
} from "../../../src/api/queries";
import { ArmedButton } from "../../../src/components/ArmedButton";
import { toastErr } from "../../../src/components/Toast";
import { colors } from "../../../src/lib/theme";

export default function MembersScreen() {
  const params = useLocalSearchParams<{ groupId: string; name?: string }>();
  const groupId = params.groupId;
  const members = useMembers(groupId);
  const agents = useAgents();
  const addMember = useAddMember(groupId);
  const removeMember = useRemoveMember(groupId);
  const [adding, setAdding] = useState(false);

  const memberAgentIds = useMemo(
    () =>
      new Set(
        (members.data ?? [])
          .filter((m) => m.member_type === "agent")
          .map((m) => m.member_id),
      ),
    [members.data],
  );
  const addable = (agents.data ?? []).filter((a) => !memberAgentIds.has(a.id));

  return (
    <>
      <Stack.Screen
        options={{ title: params.name ? `${params.name} · members` : "Members", headerShown: true }}
      />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {(members.data ?? []).map((m) => (
          <View key={`${m.member_type}:${m.member_id}:${m.channel_id ?? ""}`} style={styles.row}>
            <Text style={styles.icon}>{m.member_type === "agent" ? "🤖" : "👤"}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{m.name || m.member_id}</Text>
              <Text style={styles.meta}>
                {m.role}
                {m.channel_id ? ` · scoped to one channel` : ""}
              </Text>
            </View>
            <ArmedButton
              label="Remove"
              onConfirm={() =>
                removeMember.mutate(
                  { member_type: m.member_type, member_id: m.member_id, channel_id: m.channel_id },
                  { onError: (e) => toastErr("Remove failed", e) },
                )
              }
            />
          </View>
        ))}
        {members.isSuccess && members.data.length === 0 ? (
          <Text style={styles.empty}>No members yet.</Text>
        ) : null}

        <Pressable style={styles.addBtn} onPress={() => setAdding((a) => !a)}>
          <Text style={styles.addBtnText}>{adding ? "Cancel" : "＋ Add agent"}</Text>
        </Pressable>
        {adding
          ? addable.map((a) => (
              <Pressable
                key={a.id}
                style={styles.row}
                onPress={() =>
                  addMember.mutate(
                    { member_type: "agent", member_id: a.id },
                    {
                      onSuccess: () => setAdding(false),
                      onError: (e) => toastErr("Add failed", e),
                    },
                  )
                }
              >
                <Text style={styles.icon}>🤖</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{a.name}</Text>
                  <Text style={styles.meta}>{a.live ? "online" : "offline"}</Text>
                </View>
                <Text style={styles.addMark}>＋</Text>
              </Pressable>
            ))
          : null}
        {adding && addable.length === 0 ? (
          <Text style={styles.empty}>Every known agent is already a member.</Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 8, paddingBottom: 40 },
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
  icon: { fontSize: 18 },
  name: { color: colors.text, fontSize: 14.5, fontWeight: "600" },
  meta: { color: colors.dim, fontSize: 12 },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 20 },
  addBtn: { alignItems: "center", paddingVertical: 12 },
  addBtnText: { color: colors.a1, fontSize: 14.5, fontWeight: "700" },
  addMark: { color: colors.a2, fontSize: 18, fontWeight: "700" },
});
