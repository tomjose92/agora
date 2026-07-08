/* Toasts, ported from the desktop shim: transient, dismissible, warn
   variant. A zustand store so any hook/mutation can raise one. */

import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { create } from "zustand";
import { colors } from "../lib/theme";

interface ToastItem {
  id: number;
  message: string;
  variant?: "warn";
}

interface ToastState {
  items: ToastItem[];
  show: (message: string, variant?: "warn") => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  items: [],
  show(message, variant) {
    const id = nextId++;
    set((s) => ({ items: [...s.items, { id, message, variant }] }));
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
    }, 6000);
  },
  dismiss(id) {
    set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
  },
}));

export function toast(message: string, variant?: "warn") {
  useToasts.getState().show(message, variant);
}

/** `${msg}: ${detail}` warn toast — the desktop's agoErr. */
export function toastErr(msg: string, e: unknown) {
  const detail = e instanceof Error ? e.message : String(e);
  toast(`${msg}: ${detail}`, "warn");
}

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [opacity]);
  return (
    <Animated.View style={[styles.toast, item.variant === "warn" && styles.warn, { opacity }]}>
      <Text style={styles.msg} numberOfLines={4}>
        {item.message}
      </Text>
      <Pressable onPress={() => dismiss(item.id)} hitSlop={8}>
        <Text style={styles.x}>✕</Text>
      </Pressable>
    </Animated.View>
  );
}

export function ToastHost() {
  const items = useToasts((s) => s.items);
  if (items.length === 0) return null;
  return (
    <View style={styles.host} pointerEvents="box-none">
      {items.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    bottom: 90,
    left: 16,
    right: 16,
    gap: 8,
    alignItems: "center",
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    maxWidth: 480,
    backgroundColor: "#171a23",
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  warn: { borderColor: "rgba(248,113,113,0.5)" },
  msg: { color: colors.text, fontSize: 13.5, flexShrink: 1 },
  x: { color: colors.dim, fontSize: 13 },
});
