/* Two-step destructive action, ported from the desktop: first tap arms
   ("Sure?"), a second tap within 5s executes, otherwise it disarms. */

import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { colors } from "../lib/theme";

export function ArmedButton({
  label,
  armedLabel = "Sure?",
  onConfirm,
  style,
}: {
  label: string;
  armedLabel?: string;
  onConfirm: () => void;
  style?: ViewStyle;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const press = () => {
    if (armed) {
      if (timer.current) clearTimeout(timer.current);
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 5000);
  };

  return (
    <Pressable onPress={press} style={[styles.btn, armed && styles.armed, style]}>
      <Text style={styles.text}>{armed ? armedLabel : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(248,113,113,0.35)",
  },
  armed: { backgroundColor: "rgba(248,113,113,0.16)", borderColor: colors.red },
  text: { color: colors.red, fontSize: 12.5, fontWeight: "600" },
});
