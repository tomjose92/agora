/* Server URL + owner token live in the OS keychain (the token is root on the
   instance — never AsyncStorage). The store exposes a ready ApiClient once
   signed in. */

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import { ApiClient, ApiError, normalizeBaseUrl, type Session } from "../api/client";
import type { Me } from "../api/types";

const KEY_URL = "agora_server_url";
const KEY_TOKEN = "agora_owner_token";

type Status = "loading" | "signedOut" | "signedIn";

interface SessionState {
  status: Status;
  session: Session | null;
  username: string;
  load: () => Promise<void>;
  signIn: (serverUrl: string, token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  status: "loading",
  session: null,
  username: "",

  async load() {
    const [baseUrl, token] = await Promise.all([
      SecureStore.getItemAsync(KEY_URL),
      SecureStore.getItemAsync(KEY_TOKEN),
    ]);
    if (!baseUrl || !token) {
      set({ status: "signedOut", session: null });
      return;
    }
    // Trust stored credentials without a network round-trip so the app opens
    // offline; a 401 later drops back to the connect screen via onUnauthorized.
    const session: Session = { baseUrl, token };
    set({ status: "signedIn", session });
    // Resolve the username in the background (the WS reducer needs it for
    // unread bookkeeping). Best-effort: offline is fine, 401 signs out.
    new ApiClient(session)
      .get<Me>("/api/me")
      .then((me) => set({ username: me.username }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) void useSession.getState().signOut();
      });
  },

  async signIn(serverUrl, token) {
    const baseUrl = normalizeBaseUrl(serverUrl);
    const session: Session = { baseUrl, token: token.trim() };
    const me = await new ApiClient(session).get<Me>("/api/me"); // throws on bad token
    await Promise.all([
      SecureStore.setItemAsync(KEY_URL, baseUrl),
      SecureStore.setItemAsync(KEY_TOKEN, session.token),
    ]);
    set({ status: "signedIn", session, username: me.username });
  },

  async signOut() {
    await Promise.all([
      SecureStore.deleteItemAsync(KEY_URL),
      SecureStore.deleteItemAsync(KEY_TOKEN),
    ]);
    set({ status: "signedOut", session: null, username: "" });
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
