/* Notifications: remote Expo push while suspended (APNs/FCM), plus local
   banners as a fallback when no push token is registered (simulator / denied
   permission / Expo Go). Nothing fires while the app is active and visible,
   mirroring the desktop's unfocused-only rule. */

import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { ApiClient, type Session } from "../api/client";
import type { Message } from "../api/types";
import type { ChannelUnread } from "./unread";

const KEY_PUSH_TOKEN = "agora_push_token";

let ready = false;
/** Once we have a server-registered Expo token, WS-path local banners would
    double up with remote push — suppress them. */
let pushActive = false;

function easProjectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
}

export async function setupNotifications(): Promise<void> {
  if (ready) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: AppState.currentState !== "active",
      shouldShowList: AppState.currentState !== "active",
      shouldPlaySound: false,
      shouldSetBadge: false, // the badge tracks unread counts, not banners
    }),
  });
  try {
    await Notifications.requestPermissionsAsync();
  } catch {
    /* denied — notify() calls become no-ops at the OS level */
  }
  ready = true;
}

/** Obtain an Expo push token and register it with the server. Returns true
    when remote push is live (caller can drop the background unread poll). */
export async function registerPushToken(session: Session): Promise<boolean> {
  await setupNotifications();
  const projectId = easProjectId();
  if (!projectId) return false;
  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    token = result.data;
  } catch {
    return false; // simulator / missing entitlement / Expo Go
  }
  try {
    const api = new ApiClient(session);
    await api.post("/api/push-tokens", {
      token,
      platform: Platform.OS,
    });
    await SecureStore.setItemAsync(KEY_PUSH_TOKEN, token);
    pushActive = true;
    return true;
  } catch {
    return false;
  }
}

/** Best-effort revoke on sign-out so the server stops waking this device. */
export async function unregisterPushToken(session: Session | null): Promise<void> {
  const token = await SecureStore.getItemAsync(KEY_PUSH_TOKEN);
  pushActive = false;
  if (token) {
    await SecureStore.deleteItemAsync(KEY_PUSH_TOKEN).catch(() => {});
  }
  if (!session || !token) return;
  try {
    const api = new ApiClient(session);
    await api.delete("/api/push-tokens", { token });
  } catch {
    /* offline / already rotated — local clear is enough */
  }
}

export function notifyAgentMessage(message: Message): void {
  if (pushActive) return; // remote push covers suspended + backgrounded
  if (AppState.currentState === "active") return;
  const title = message.author_name || message.author_id;
  const body =
    message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text || "(attachment)";
  void Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      // Tap routing (see notificationTarget in unread.ts).
      data: { channel_id: message.channel_id, thread_id: message.thread_id },
    },
    trigger: null, // now
  });
}

/** One catch-up banner per channel with new activity, from the poller.
    Mentions lead the copy so "someone @'d you" isn't buried in traffic. */
export function notifyUnreadChannel(
  channel: ChannelUnread,
  newCount: number,
  newMentions = 0,
): void {
  const body =
    newMentions > 0
      ? newMentions === 1
        ? "You were mentioned"
        : `${newMentions} mentions`
      : newCount === 1
        ? "1 new message"
        : `${newCount} new messages`;
  void Notifications.scheduleNotificationAsync({
    content: {
      title: `${channel.group} / #${channel.name}`,
      body,
      data: { channel_id: channel.id },
    },
    trigger: null,
  });
}

/** App-icon badge = total unread; reads (anywhere) bring it back down. */
export function setBadge(total: number): void {
  Notifications.setBadgeCountAsync(total).catch(() => {
    /* simulators without badge support */
  });
}
