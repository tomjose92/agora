/* Known agents: live status dots and forget-offline-agent, same rules as
   the desktop (the server refuses to forget a connected agent). */

import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { useAgents, useForgetAgent } from "../../src/api/queries";
import { AgentAvatar } from "../../src/components/AgentAvatar";
import { ArmedButton } from "../../src/components/ArmedButton";
import { toastErr } from "../../src/components/Toast";
import { fmtTs } from "../../src/lib/format";
import { colors } from "../../src/lib/theme";

export default function AgentsScreen() {
  const agents = useAgents();
  const forget = useForgetAgent();

  return (
    <>
      <Stack.Screen options={{ title: "Agents", headerShown: true }} />
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={agents.isRefetching}
            onRefresh={() => void agents.refetch()}
            tintColor={colors.dim}
          />
        }
      >
        {(agents.data ?? []).map((a) => (
          <View key={a.id} style={styles.row}>
            <AgentAvatar agentId={a.id} size={30} />
            <View style={[styles.dot, a.live ? styles.dotOn : styles.dotOff]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{a.name}</Text>
              <Text style={styles.meta}>
                {a.source}
                {a.requires_mention ? " · mention-only" : ""}
                {a.live ? " · online" : ` · last seen ${fmtTs(a.last_seen)}`}
              </Text>
            </View>
            {!a.live ? (
              <ArmedButton
                label="Forget"
                onConfirm={() =>
                  forget.mutate(a.id, { onError: (e) => toastErr("Forget failed", e) })
                }
              />
            ) : null}
          </View>
        ))}
        {agents.isSuccess && agents.data.length === 0 ? (
          <Text style={styles.empty}>
            No agents yet. Add a connection (Settings) or pair a bridge, and agents will
            appear here when they dial in.
          </Text>
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
    gap: 12,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  dotOn: { backgroundColor: colors.green },
  dotOff: { backgroundColor: colors.faint },
  name: { color: colors.text, fontSize: 14.5, fontWeight: "700" },
  meta: { color: colors.dim, fontSize: 12 },
  empty: { color: colors.dim, textAlign: "center", paddingVertical: 24, lineHeight: 20 },
});
