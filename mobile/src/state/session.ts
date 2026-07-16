/* Server URL + admin key live in the OS keychain (the token is root on the
   instance — never AsyncStorage). The store exposes a ready ApiClient once
   signed in. */

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import {
  ApiClient,
  normalizeBaseUrl,
  originOf,
  parseError,
  type Session,
} from "../api/client";
import type { Me } from "../api/types";

/* Shared with the background poller, which reads credentials without the store. */
export const KEY_URL = "agora_server_url";
export const KEY_TOKEN = "agora_admin_key";
/** Pre-rename keychain slot ("owner token" era); migrated in load(). */
const KEY_TOKEN_LEGACY = "agora_owner_token";

type Status = "loading" | "signedOut" | "signedIn";

interface SessionState {
  status: Status;
  session: Session | null;
  username: string;
  /** Server-side STT/TTS available (me.voice) — gates all voice UI. */
  voiceOk: boolean;
  /** Last known server URL. Survives a sign-out (an expired Google session
      should ask for credentials again, not for the server address), cleared
      only by forgetServer. */
  savedUrl: string;
  load: () => Promise<void>;
  signIn: (serverUrl: string, token: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Sign out AND drop the stored server URL (switching instances). */
  forgetServer: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  status: "loading",
  session: null,
  username: "",
  voiceOk: false,
  savedUrl: "",

  async load() {
    let [baseUrl, token] = await Promise.all([
      SecureStore.getItemAsync(KEY_URL),
      SecureStore.getItemAsync(KEY_TOKEN),
    ]);
    // One-time keychain migration from the pre-rename slot.
    if (!token) {
      const legacy = await SecureStore.getItemAsync(KEY_TOKEN_LEGACY);
      if (legacy) {
        token = legacy;
        await SecureStore.setItemAsync(KEY_TOKEN, legacy);
        await SecureStore.deleteItemAsync(KEY_TOKEN_LEGACY);
      }
    }
    if (!baseUrl || !token) {
      set({ status: "signedOut", session: null, savedUrl: baseUrl || "" });
      return;
    }
    // Trust stored credentials without a network round-trip so the app opens
    // offline; a 401 later drops back to the connect screen via onUnauthorized.
    const session: Session = { baseUrl, token };
    set({ status: "signedIn", session, savedUrl: baseUrl });
    // Background /api/me: resolves the username (the WS reducer needs it for
    // unread bookkeeping) and heals a stale scheme — sessions stored before
    // redirect canonicalization keep http:// for hosts that are really
    // https, which silently kills the live socket. Best-effort: offline is
    // fine, 401 signs out.
    fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (res.status === 401) {
          void useSession.getState().signOut();
          return;
        }
        if (!res.ok) return;
        const me = (await res.json()) as Me;
        const canonical = originOf(res.url, baseUrl);
        if (canonical !== baseUrl) {
          await SecureStore.setItemAsync(KEY_URL, canonical);
          set({ session: { baseUrl: canonical, token } });
        }
        set({ username: me.username, voiceOk: !!me.voice });
      })
      .catch(() => {
        /* offline — keep the stored session */
      });
  },

  async signIn(serverUrl, token) {
    let guess = normalizeBaseUrl(serverUrl);
    const trimmed = token.trim();
    // Find the canonical origin with an unauthenticated request BEFORE
    // sending the token: iOS drops the Authorization header when fetch
    // follows a redirect, so a stored http:// URL against a host that 301s
    // to https turns a perfectly good token into a 401. (This also stores
    // the canonical origin, which the WebSocket needs — it can't follow
    // redirects at all.)
    const probe = await fetch(`${guess}/api/auth/config`).catch(() => null);
    if (probe) guess = originOf(probe.url, guess);
    const res = await fetch(`${guess}/api/me`, {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    if (!res.ok) throw await parseError(res);
    const me = (await res.json()) as Me;
    const session: Session = { baseUrl: originOf(res.url, guess), token: trimmed };
    await Promise.all([
      SecureStore.setItemAsync(KEY_URL, session.baseUrl),
      SecureStore.setItemAsync(KEY_TOKEN, session.token),
    ]);
    set({
      status: "signedIn",
      session,
      username: me.username,
      voiceOk: !!me.voice,
      savedUrl: session.baseUrl,
    });
  },

  async signOut() {
    // Keep KEY_URL: the login screen should only ask for credentials again.
    await SecureStore.deleteItemAsync(KEY_TOKEN);
    set({ status: "signedOut", session: null, username: "", voiceOk: false });
  },

  async forgetServer() {
    await Promise.all([
      SecureStore.deleteItemAsync(KEY_URL),
      SecureStore.deleteItemAsync(KEY_TOKEN),
    ]);
    set({ status: "signedOut", session: null, username: "", voiceOk: false, savedUrl: "" });
  },
}));

/** The signed-in ApiClient. Screens under (app)/ may assume a session. */
export function useApi(): ApiClient {
  const session = useSession((s) => s.session);
  if (!session) throw new Error("useApi called while signed out");
  return new ApiClient(session);
}

export function onUnauthorized() {
  void useSession.getState().signOut();
}
