/* Onboarding: point the app at a headless agora-server and paste the owner
   token it prints on boot (the mobile analogue of the web UI's auth gate). */

import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Redirect } from "expo-router";
import { useSession } from "../src/state/session";
import { colors, radius } from "../src/lib/theme";

export default function Connect() {
  const { status, signIn } = useSession();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (status === "signedIn") return <Redirect href="/(app)" />;

  const submit = async () => {
    if (!url.trim() || !token.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await signIn(url, token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.brand}>▣ Agora</Text>
        <Text style={styles.hint}>
          Connect to your Agora server. The owner token is printed in the
          server log (or lives in its config.json).
        </Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="https://agora.example.com"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="owner token"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          onSubmitEditing={submit}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          style={[styles.btn, (!url.trim() || !token.trim() || busy) && styles.btnOff]}
          onPress={submit}
          disabled={!url.trim() || !token.trim() || busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={styles.btnText}>Connect</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    padding: 24,
    gap: 14,
  },
  brand: { color: colors.text, fontSize: 22, fontWeight: "800", letterSpacing: 0.5 },
  hint: { color: colors.dim, fontSize: 13.5, lineHeight: 19 },
  input: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
  },
  error: { color: colors.red, fontSize: 13 },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 12,
  },
  btnOff: { opacity: 0.4 },
  btnText: { color: colors.onAccent, fontSize: 15, fontWeight: "700" },
});
