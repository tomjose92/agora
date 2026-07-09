/* Local notifications for agent messages that arrive while the app is
   backgrounded but the socket is still alive (the v1 story — true push
   needs server-side APNs/FCM, see the plan). Nothing fires while the app
   is active and visible, mirroring the desktop's unfocused-only rule. */

import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import type { Message } from "../api/types";

let ready = false;

export async function setupNotifications(): Promise<void> {
  if (ready) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  try {
    await Notifications.requestPermissionsAsync();
  } catch {
    /* denied — notify() calls become no-ops at the OS level */
  }
  ready = true;
}

export function notifyAgentMessage(message: Message): void {
  if (AppState.currentState === "active") return;
  const title = message.author_name || message.author_id;
  const body =
    message.text.length > 140 ? `${message.text.slice(0, 140)}…` : message.text || "(attachment)";
  void Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: null, // now
  });
}
