/* Signed-in shell: guards the group, keeps the live socket mounted for the
   whole session, and wires agent messages to local notifications. */

import React, { useEffect } from "react";
import { Redirect, Stack } from "expo-router";
import { useSession } from "../../src/state/session";
import { useAgoraSocket } from "../../src/ws/useAgoraSocket";
import { notifyAgentMessage, setupNotifications } from "../../src/lib/notifications";
import { colors } from "../../src/lib/theme";

function LiveSocket() {
  const session = useSession((s) => s.session)!;
  const username = useSession((s) => s.username);
  useAgoraSocket(session, username, notifyAgentMessage);
  return null;
}

export default function AppLayout() {
  const status = useSession((s) => s.status);
  useEffect(() => {
    void setupNotifications();
  }, []);

  if (status === "loading") return null;
  if (status !== "signedIn") return <Redirect href="/connect" />;

  return (
    <>
      <LiveSocket />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: "700" },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </>
  );
}
