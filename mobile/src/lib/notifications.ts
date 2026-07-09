/* Local notifications for agent messages that arrive while the app is
   backgrounded but the socket is still alive, plus the catch-up banners the
   background poller fires (see background.ts). True instant push while
   suspended needs server-side APNs — see the README's notification matrix.
   Nothing fires while the app is active and visible, mirroring the
   desktop's unfocused-only rule. */

import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import type { Message } from "../api/types";
import type { ChannelUnread } from "./unread";

let ready = false;

export async function setupNotifications(): Promise<void> {
  if (ready) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
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

export function notifyAgentMessage(message: Message): void {
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
