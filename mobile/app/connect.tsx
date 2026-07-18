/* Login: the mobile flavor of the desktop connect page. Two steps —
   pick the server (first run only; a signed-out relaunch remembers it),
   then sign in: Apple/Google when the server offers them, admin key
   always. */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Redirect } from "expo-router";
import { Image as ExpoImage } from "expo-image";
import * as AppleAuthentication from "expo-apple-authentication";
import * as WebBrowser from "expo-web-browser";
import { normalizeBaseUrl, originOf } from "../src/api/client";
import { appleAvailable, runAppleFlow } from "../src/lib/appleAuth";
import { probeAuth } from "../src/lib/authConfig";
import { runGoogleFlow } from "../src/lib/googleAuth";
import { forgetRecentServer, loadRecentServers } from "../src/state/servers";
import { useSession } from "../src/state/session";
import { colors, radius } from "../src/lib/theme";

// Closes the auth sheet if the deep link cold-started the app mid-flow.
WebBrowser.maybeCompleteAuthSession();

type Step = "server" | "signin";

export default function Connect() {
  const { status, savedUrl, signIn } = useSession();
  const [step, setStep] = useState<Step>(savedUrl ? "signin" : "server");
  const [url, setUrl] = useState(savedUrl);
  const [base, setBase] = useState(savedUrl); // normalized, probed URL
  const [google, setGoogle] = useState(false);
  const [apple, setApple] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Force Google's account chooser on retries (see runGoogleFlow).
  const [googleRetry, setGoogleRetry] = useState(false);
  // Previously joined servers: tap to reconnect, × to forget.
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    void loadRecentServers().then(setRecent);
  }, []);

  // A signed-out relaunch knows the server before the first render settles.
  useEffect(() => {
    if (savedUrl && !url) {
      setUrl(savedUrl);
      setBase(savedUrl);
      setStep("signin");
    }
  }, [savedUrl, url]);

  const probe = useCallback(async (target: string) => {
    const methods = await probeAuth(target);
    // A signed-out relaunch reuses the keychain URL verbatim; if it carries a
    // stale scheme (http:// against a host that 301s to https), sign-in would
    // 401 forever — iOS strips the Authorization header across redirects. Swap
    // in the origin the server actually answered from before any sign-in runs.
    if (methods.origin !== target) {
      setBase(methods.origin);
      return; // the base effect re-probes with the canonical origin
    }
    // The Apple button needs both server support and a build carrying the
    // Sign in with Apple capability (dev builds on a free team don't).
    const appleOk = methods.apple && (await appleAvailable());
    setGoogle(methods.google);
    setApple(appleOk);
    setShowToken(!methods.google && !appleOk); // token-only servers show the form outright
  }, []);

  useEffect(() => {
    if (step === "signin" && base) void probe(base);
  }, [step, base, probe]);

  if (status === "signedIn") return <Redirect href="/(app)" />;

  const toSignin = async (target?: string) => {
    const entered = target ?? url;
    if (!entered.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const normalized = normalizeBaseUrl(entered);
      // Reachability check that also learns the sign-in methods. Keep the
      // origin the server actually answered from (http 301s to https): later
      // authorized requests must not cross a redirect, which strips the
      // Authorization header on iOS.
      const res = await fetch(`${normalized}/api/auth/config`).catch(() => null);
      if (!res) throw new Error("Could not reach that server");
      setBase(originOf(res.url, normalized));
      setStep("signin");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitToken = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await signIn(base, token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitGoogle = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await runGoogleFlow(base, googleRetry);
      // A dismissed sheet is not an error — just return to the form.
      if (session) await signIn(base, session);
    } catch (e) {
      setGoogleRetry(true);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitApple = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const session = await runAppleFlow(base);
      // A dismissed sheet is not an error — just return to the form.
      if (session) await signIn(base, session);
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
        <View style={styles.brand}>
          <Image source={require("../assets/icon.png")} style={styles.logo} />
          <Text style={styles.brandName}>Agora</Text>
        </View>

        {step === "server" ? (
          <>
            <Text style={styles.hint}>
              Where people and AI agents share rooms. Point the app at your
              Agora server to get started.
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
              onSubmitEditing={() => void toSignin()}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable
              style={[styles.btn, (!url.trim() || busy) && styles.btnOff]}
              onPress={() => void toSignin()}
              disabled={!url.trim() || busy}
            >
              {busy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.btnText}>Continue</Text>
              )}
            </Pressable>
            {recent.length ? (
              <View style={styles.recent}>
                <Text style={styles.recentTitle}>Recent servers</Text>
                {recent.map((server) => (
                  <View key={server} style={styles.recentRow}>
                    <Pressable
                      style={[styles.recentPick, busy && styles.btnOff]}
                      onPress={() => {
                        setUrl(server);
                        void toSignin(server);
                      }}
                      disabled={busy}
                    >
                      <Text style={styles.recentPickText} numberOfLines={1}>
                        {server.replace(/^https?:\/\//, "")}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={styles.recentRemove}
                      onPress={() => void forgetRecentServer(server).then(setRecent)}
                      disabled={busy}
                      accessibilityLabel={`Remove ${server} from recent servers`}
                      hitSlop={8}
                    >
                      <Text style={styles.recentRemoveText}>×</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Text style={styles.serverChip}>
              Sign in to <Text style={styles.serverHost}>{base.replace(/^https?:\/\//, "")}</Text>
            </Text>
            {apple ? (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                cornerRadius={10}
                style={[styles.btnApple, busy && styles.btnOff]}
                onPress={submitApple}
              />
            ) : null}
            {google ? (
              <Pressable style={[styles.btnGoogle, busy && styles.btnOff]} onPress={submitGoogle} disabled={busy}>
                {busy ? (
                  <ActivityIndicator color="#1f1f1f" />
                ) : (
                  <>
                    {/* Official multicolor G; RN's Image can't do SVG, expo-image can. */}
                    <ExpoImage source={require("../assets/google-g.svg")} style={styles.googleG} />
                    <Text style={styles.btnGoogleText}>Continue with Google</Text>
                  </>
                )}
              </Pressable>
            ) : null}
            {showToken ? (
              <>
                <TextInput
                  style={styles.input}
                  value={token}
                  onChangeText={setToken}
                  placeholder="admin key (from the server log)"
                  placeholderTextColor={colors.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  onSubmitEditing={submitToken}
                />
                <Pressable
                  style={[styles.btn, (!token.trim() || busy) && styles.btnOff]}
                  onPress={submitToken}
                  disabled={!token.trim() || busy}
                >
                  {busy && !google ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text style={styles.btnText}>Sign in as admin</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <Pressable
                style={[styles.btnGhost, busy && styles.btnOff]}
                onPress={() => setShowToken(true)}
                disabled={busy}
              >
                <Text style={styles.btnGhostText}>Sign in as admin</Text>
              </Pressable>
            )}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable
              style={[styles.btnSubtle, busy && styles.btnOff]}
              onPress={() => {
                setError("");
                setStep("server");
              }}
              disabled={busy}
            >
              <Text style={styles.btnSubtleText}>Change server</Text>
            </Pressable>
          </>
        )}
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
  brand: { alignItems: "center", gap: 10, marginBottom: 2 },
  logo: { width: 72, height: 72, borderRadius: 18 },
  brandName: { color: colors.text, fontSize: 24, fontWeight: "800", letterSpacing: 0.5 },
  hint: { color: colors.dim, fontSize: 13.5, lineHeight: 19, textAlign: "center" },
  serverChip: { color: colors.dim, fontSize: 13.5, textAlign: "center" },
  serverHost: { color: colors.text, fontWeight: "700" },
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
  error: { color: colors.red, fontSize: 13, textAlign: "center" },
  btn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 12,
  },
  btnOff: { opacity: 0.4 },
  btnText: { color: colors.onAccent, fontSize: 15, fontWeight: "700" },
  // Apple's native button draws itself; we only size it to match our rows.
  btnApple: { width: "100%", height: 44 },
  btnGoogle: {
    backgroundColor: "#fff",
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
  },
  googleG: { width: 18, height: 18 },
  btnGoogleText: { color: "#1f1f1f", fontSize: 15, fontWeight: "700" },
  // Secondary: bordered button, one visual step below the primary/Google.
  btnGhost: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 12,
  },
  btnGhostText: { color: colors.text, fontSize: 14.5, fontWeight: "600" },
  recent: { gap: 6, marginTop: 2 },
  recentTitle: {
    color: colors.dim,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  recentRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  recentPick: {
    flex: 1,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  recentPickText: { color: colors.text, fontSize: 13.5, fontWeight: "600" },
  recentRemove: {
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    borderRadius: 10,
  },
  recentRemoveText: { color: colors.dim, fontSize: 17, lineHeight: 18 },
  // Tertiary: quiet but still a full-width tappable button.
  btnSubtle: {
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
    marginTop: 2,
  },
  btnSubtleText: { color: colors.dim, fontSize: 13.5, fontWeight: "600" },
});
