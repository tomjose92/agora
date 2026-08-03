import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { isChromeAvailable } from "../lib/openLink";
import { colors } from "../lib/theme";
import type { LinkBrowser } from "../state/prefs";

export function LinkPreferences({
  preferNativeApps,
  browser,
  onPreferNativeAppsChange,
  onBrowserChange,
  chromeAvailable: givenChromeAvailable,
}: {
  preferNativeApps: boolean;
  browser: LinkBrowser;
  onPreferNativeAppsChange: (on: boolean) => void;
  onBrowserChange: (browser: LinkBrowser) => void;
  chromeAvailable?: boolean;
}) {
  const [detectedChrome, setDetectedChrome] = useState(false);
  useEffect(() => {
    if (givenChromeAvailable !== undefined) return;
    void isChromeAvailable().then(setDetectedChrome).catch(() => setDetectedChrome(false));
  }, [givenChromeAvailable]);
  const chromeAvailable = givenChromeAvailable ?? detectedChrome;
  const choices: {
    value: LinkBrowser;
    label: string;
    detail: string;
    disabled?: boolean;
  }[] = [
    { value: "in-app", label: "In-app browser", detail: "Stay inside Agora" },
    { value: "system", label: "System browser", detail: "Your device default" },
    {
      value: "chrome",
      label: "Chrome",
      detail: chromeAvailable ? "Open with Google Chrome" : "Not installed",
      disabled: !chromeAvailable,
    },
  ];

  return (
    <View style={styles.card}>
      <View style={styles.nativeRow}>
        <View style={styles.copy}>
          <Text style={styles.name}>Open supported links in apps</Text>
          <Text style={styles.meta}>Use Google Maps or YouTube when supported and installed.</Text>
        </View>
        <Switch
          value={preferNativeApps}
          onValueChange={onPreferNativeAppsChange}
          trackColor={{ false: colors.borderStrong, true: colors.a1 }}
        />
      </View>
      <Text style={styles.heading}>Browser fallback</Text>
      {choices.map((choice) => {
        const selected = choice.value === browser;
        return (
          <Pressable
            key={choice.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: choice.disabled }}
            disabled={choice.disabled}
            style={[styles.choice, choice.disabled && styles.choiceDisabled]}
            onPress={() => onBrowserChange(choice.value)}
          >
            <View style={[styles.radio, selected && styles.radioSelected]} />
            <View style={styles.copy}>
              <Text style={styles.name}>{choice.label}</Text>
              <Text style={styles.meta}>{choice.detail}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  nativeRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  heading: { color: colors.dim, fontSize: 11, fontWeight: "800", textTransform: "uppercase", paddingHorizontal: 14, paddingTop: 6 },
  choice: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
  choiceDisabled: { opacity: 0.45 },
  copy: { flex: 1 },
  name: { color: colors.text, fontSize: 14, fontWeight: "700" },
  meta: { color: colors.dim, fontSize: 12, marginTop: 2 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.borderStrong },
  radioSelected: { borderWidth: 5, borderColor: colors.a1 },
});
