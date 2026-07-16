/* Signed-in shell: guards the group, keeps the live socket mounted for the
   whole session, and wires agent messages to local notifications — plus
   notification-tap routing, the unread app badge, and the background
   unread poller. */

import React, { useEffect, useRef } from "react";
import { Redirect, Stack, router, type Href } from "expo-router";
import * as Notifications from "expo-notifications";
import { useSession } from "../../src/state/session";
import { useAgoraSocket } from "../../src/ws/useAgoraSocket";
import { emitAgentMessage } from "../../src/lib/agentBus";
import { notifyAgentMessage, setBadge, setupNotifications } from "../../src/lib/notifications";
import { registerBackgroundPolling, saveUnreadSnapshot } from "../../src/lib/background";
import { notificationTarget, totalThreadUnread, totalUnread } from "../../src/lib/unread";
import { useGroups, useThreads } from "../../src/api/queries";
import { headerBack } from "../../src/lib/headerItems";
import { colors } from "../../src/lib/theme";

function LiveSocket() {
  const session = useSession((s) => s.session)!;
  const username = useSession((s) => s.username);
  useAgoraSocket(session, username, (m) => {
    emitAgentMessage(m); // speak-aloud / live voice subscribers
    notifyAgentMessage(m);
  });
  return null;
}

/** Badge = channel unreads + thread unreads; snapshot feeds the background
    poller's diff so messages read here don't come back as stale banners. */
function UnreadSync() {
  const groups = useGroups().data;
  const threads = useThreads().data;
  useEffect(() => {
    if (!groups) return;
    setBadge(totalUnread(groups) + totalThreadUnread(threads ?? []));
    saveUnreadSnapshot(groups);
  }, [groups, threads]);
  return null;
}

/** Tapping a banner lands in its channel (or thread). Covers warm taps and
    cold starts alike via the last-response hook. */
function NotificationTapRouter() {
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!response) return;
    const id = response.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const target = notificationTarget(response.notification.request.content.data);
    if (target) router.push(target as Href);
  }, [response]);
  return null;
}

export default function AppLayout() {
  const status = useSession((s) => s.status);
  useEffect(() => {
    void setupNotifications();
  }, []);
  useEffect(() => {
    if (status !== "signedIn") return;
    void registerBackgroundPolling();
  }, [status]);

  if (status === "loading") return null;
  if (status !== "signedIn") return <Redirect href="/connect" />;

  return (
    <>
      <LiveSocket />
      <UnreadSync />
      <NotificationTapRouter />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: "700" },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
          ...headerBack(),
        }}
      />
    </>
  );
}
