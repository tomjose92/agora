import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
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
      <Pressable accessibilityRole="none" style={styles.backdrop} onPress={onClose}>
        <View style={styles.content} pointerEvents="box-none" accessibilityViewIsModal>
          <Pressable accessibilityRole="button" accessibilityLabel="Close image preview"
            style={styles.close} onPress={onClose}>
            <Icon icon={X} size={22} color="#fff" />
          </Pressable>
          <Image source={source} style={styles.image} contentFit="contain"
            accessibilityLabel={filename} />
          <Text style={styles.filename} numberOfLines={1}>{filename}</Text>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, padding: 20, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(4,6,10,0.92)",
  },
  content: { width: "100%", height: "88%", alignItems: "center", justifyContent: "center" },
  close: {
    position: "absolute", top: 0, right: 0, zIndex: 1, width: 40, height: 40,
    borderRadius: 20, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(20,22,30,0.92)",
  },
  image: { width: "100%", height: "90%" },
  filename: { maxWidth: "86%", marginTop: 10, color: "rgba(255,255,255,0.82)", fontSize: 12 },
});
