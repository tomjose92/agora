/* Settings: Pantheo connections (live status, add/toggle/remove), pairing
   tokens for dial-in bridges, and the session (server info / sign out).
   Polls every 4s while open, like the desktop connections pane. */

import React, { useState } from "react";
import {
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { keys } from "../../src/api/keys";
import {
  useConnectionMutations,
  useConnections,
  usePairingMutations,
  usePairingTokens,
} from "../../src/api/queries";
import type { Me } from "../../src/api/types";
import { ArmedButton } from "../../src/components/ArmedButton";
import { toast, toastErr } from "../../src/components/Toast";
import { fmtTs } from "../../src/lib/format";
import { colors, mono } from "../../src/lib/theme";
import { useApi, useSession } from "../../src/state/session";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function AddConnection() {
  const { add } = useConnectionMutations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  if (!open) {
    return (
      <Pressable style={styles.linkBtn} onPress={() => setOpen(true)}>
        <Text style={styles.linkBtnText}>＋ Add connection</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.form}>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="name (e.g. home)"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="wss://pantheo.example.com/agora/connect"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        keyboardType="url"
      />
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="connection token"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        secureTextEntry
      />
      <View style={styles.formRow}>
        <Pressable style={styles.linkBtn} onPress={() => setOpen(false)}>
          <Text style={styles.linkBtnDim}>Cancel</Text>
        </Pressable>
        <Pressable
          style={styles.linkBtn}
          onPress={() =>
            add.mutate(
              { name: name.trim(), url: url.trim(), token: token.trim() },
              {
                onSuccess: () => {
                  setOpen(false);
                  setName("");
                  setUrl("");
                  setToken("");
                },
                onError: (e) => toastErr("Add failed", e),
              },
            )
          }
        >
          <Text style={styles.linkBtnText}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const api = useApi();
  const session = useSession((s) => s.session)!;
  const signOut = useSession((s) => s.signOut);
  const me = useQuery({ queryKey: keys.me, queryFn: () => api.get<Me>("/api/me") });
  const connections = useConnections(true); // poll while this screen is open
  const { update, remove } = useConnectionMutations();
  const pairing = usePairingTokens();
  const pairingMut = usePairingMutations();
  const [bridgeName, setBridgeName] = useState("");

  return (
    <>
      <Stack.Screen options={{ title: "Settings", headerShown: true }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Section title="Connections">
          {(connections.data ?? []).map((c) => {
            const status = c.status;
            const dot = !c.enabled
              ? colors.faint
              : status?.connected
                ? colors.green
                : colors.red;
            return (
              <View key={c.name} style={styles.row}>
                <View style={[styles.dot, { backgroundColor: dot }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{c.name}</Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {c.url}
                  </Text>
                  {c.enabled && status && !status.connected && status.last_error ? (
                    <Text style={styles.err} numberOfLines={2}>
                      {status.last_error}
                    </Text>
                  ) : null}
                  {status?.connected && status.agents.length > 0 ? (
                    <Text style={styles.meta}>
                      {status.agents.length} agent{status.agents.length === 1 ? "" : "s"}
                    </Text>
                  ) : null}
                </View>
                <Switch
                  value={c.enabled}
                  onValueChange={(enabled) =>
                    update.mutate(
                      { name: c.name, enabled },
                      { onError: (e) => toastErr("Update failed", e) },
                    )
                  }
                  trackColor={{ true: colors.a1, false: colors.faint }}
                />
                <ArmedButton
                  label="Remove"
                  onConfirm={() =>
                    remove.mutate(c.name, { onError: (e) => toastErr("Remove failed", e) })
                  }
                />
              </View>
            );
          })}
          {connections.isSuccess && connections.data.length === 0 ? (
            <Text style={styles.empty}>
              No connections. Link a Pantheo instance to bring its agents in.
            </Text>
          ) : null}
          <AddConnection />
        </Section>

        <Section title="Pairing tokens">
          {(pairing.data ?? []).map((t) => (
            <View key={t.token} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{t.name}</Text>
                <Text style={styles.meta}>created {fmtTs(t.created_at)}</Text>
                <Pressable onPress={() => void Share.share({ message: t.token })}>
                  <Text style={styles.tokenText} numberOfLines={1}>
                    {t.token.slice(0, 10)}… (tap to share)
                  </Text>
                </Pressable>
              </View>
              <ArmedButton
                label="Revoke"
                onConfirm={() =>
                  pairingMut.revoke.mutate(t.token, {
                    onError: (e) => toastErr("Revoke failed", e),
                  })
                }
              />
            </View>
          ))}
          <View style={styles.formRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={bridgeName}
              onChangeText={setBridgeName}
              placeholder="bridge name"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
            />
            <Pressable
              style={styles.linkBtn}
              onPress={() =>
                pairingMut.create.mutate(bridgeName.trim() || "bridge", {
                  onSuccess: (r) => {
                    setBridgeName("");
                    void Share.share({ message: r.token });
                    toast("Pairing token created");
                  },
                  onError: (e) => toastErr("Create failed", e),
                })
              }
            >
              <Text style={styles.linkBtnText}>Issue</Text>
            </Pressable>
          </View>
        </Section>

        <Section title="Session">
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{session.baseUrl}</Text>
              <Text style={styles.meta}>
                {me.data
                  ? `signed in as ${me.data.username} · server v${me.data.version}`
                  : me.isError
                    ? "server unreachable"
                    : "…"}
              </Text>
            </View>
            <ArmedButton label="Sign out" onConfirm={() => void signOut()} />
          </View>
        </Section>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 14, gap: 20, paddingBottom: 40 },
  section: { gap: 8 },
  sectionTitle: {
    color: colors.dim,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  name: { color: colors.text, fontSize: 14, fontWeight: "700" },
  meta: { color: colors.dim, fontSize: 12 },
  err: { color: colors.red, fontSize: 11.5, marginTop: 2 },
  tokenText: { ...mono, color: colors.a2, fontSize: 12, marginTop: 3 },
  empty: { color: colors.dim, fontSize: 13, paddingVertical: 8 },
  form: { gap: 8 },
  formRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  input: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  linkBtn: { paddingVertical: 10, alignItems: "center" },
  linkBtnText: { color: colors.a1, fontSize: 14, fontWeight: "700" },
  linkBtnDim: { color: colors.dim, fontSize: 14, fontWeight: "600" },
});
