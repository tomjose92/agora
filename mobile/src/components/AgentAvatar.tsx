/* Agent avatar shared by messages, members, and the agents list: the picture
   proxied from the agent's home instance (AgentInfo.avatar from /api/agents),
   falling back to the robot emoji when the agent has none or the load fails. */

import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { authHeaders } from "../api/client";
import { useAgents } from "../api/queries";
import { useSession } from "../state/session";
import { colors } from "../lib/theme";

export function AgentAvatar({ agentId, size = 30 }: { agentId: string; size?: number }) {
  const session = useSession((s) => s.session);
  const agents = useAgents();
  const [failed, setFailed] = useState(false);
  const avatar = (agents.data ?? []).find((a) => a.id === agentId)?.avatar ?? null;
  const box = { width: size, height: size, borderRadius: size * 0.3 };

  if (session && avatar && !failed) {
    return (
      <Image
        source={{ uri: `${session.baseUrl}${avatar}`, headers: authHeaders(session) }}
        style={[styles.image, box]}
        contentFit="cover"
        transition={100}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View style={[styles.fallback, box]}>
      <Text style={{ fontSize: size * 0.5 }}>🤖</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: { backgroundColor: colors.panelStrong },
  fallback: {
    backgroundColor: "rgba(139,124,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
});
