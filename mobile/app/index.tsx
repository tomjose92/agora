import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { useSession } from "../src/state/session";
import { colors } from "../src/lib/theme";

export default function Index() {
  const status = useSession((s) => s.status);
  if (status === "loading") {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.a1} />
      </View>
    );
  }
  return <Redirect href={status === "signedIn" ? "/(app)" : "/connect"} />;
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
});
