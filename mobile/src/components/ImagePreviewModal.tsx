import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Image, type ImageSource } from "expo-image";
import { X } from "lucide-react-native";
import { Icon } from "./Icon";

export function ImagePreviewModal({ source, filename, onClose }: {
  source: ImageSource;
  filename: string;
  onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root} accessibilityViewIsModal>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss image preview"
          style={styles.backdrop} onPress={onClose} />
        <View style={styles.content}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close image preview"
            style={styles.close} onPress={onClose}>
            <Icon icon={X} size={22} color="#fff" />
          </Pressable>
          <Image source={source} style={styles.image} contentFit="contain" accessible
            accessibilityLabel={filename} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center" },
  backdrop: {
    position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
    backgroundColor: "rgba(4,6,10,0.92)",
  },
  content: {
    width: "100%", height: "88%", padding: 20, alignItems: "center",
    justifyContent: "center",
  },
  close: {
    position: "absolute", top: 0, right: 0, zIndex: 1, width: 40, height: 40,
    borderRadius: 20, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(20,22,30,0.92)",
  },
  image: { width: "100%", height: "100%" },
});
