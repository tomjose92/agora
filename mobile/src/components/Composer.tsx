/* Message composer: text, attachments (max 5, like the server), and
   @mention autocomplete over the channel's live agents + group members. */

import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { OutgoingFile } from "../api/queries";
import { slugify } from "../lib/format";
import { useKeyboardVisible } from "../lib/keyboard";
import { colors } from "../lib/theme";
import { toast, toastErr } from "./Toast";

const MAX_FILES = 5;

export interface MentionCandidate {
  id: string;
  name: string;
}

export function Composer({
  placeholder,
  mentions,
  sending,
  onSend,
}: {
  placeholder: string;
  mentions: MentionCandidate[];
  sending: boolean;
  onSend: (v: { text: string; files: OutgoingFile[] }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<OutgoingFile[]>([]);
  const selection = useRef({ start: 0, end: 0 });
  const inputRef = useRef<TextInput>(null);

  /* Clear the home indicator when the keyboard is down; sit flush against
     the keyboard when it's up (the KeyboardAvoidingView handles the lift). */
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const bottomPad = keyboardVisible ? 6 : Math.max(insets.bottom, 6);

  /* @mention autocomplete: active while the token before the cursor looks
     like a partial mention. */
  const mentionQuery = useMemo(() => {
    const upto = text.slice(0, selection.current.start || text.length);
    const m = /(^|\s)@([a-z0-9-]*)$/i.exec(upto);
    return m ? m[2].toLowerCase() : null;
  }, [text]);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    return mentions
      .filter((c) => slugify(c.name).startsWith(mentionQuery) || c.id.toLowerCase().startsWith(mentionQuery))
      .slice(0, 6);
  }, [mentionQuery, mentions]);

  const insertMention = (c: MentionCandidate) => {
    const at = selection.current.start || text.length;
    const before = text.slice(0, at).replace(/@[a-z0-9-]*$/i, `@${slugify(c.name)} `);
    setText(before + text.slice(at));
    inputRef.current?.focus();
  };

  const addFiles = (picked: OutgoingFile[]) => {
    const merged = [...files, ...picked].slice(0, MAX_FILES);
    if (files.length + picked.length > MAX_FILES) toast(`Max ${MAX_FILES} files per message`, "warn");
    setFiles(merged);
  };

  const pickDocuments = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (res.canceled) return;
      addFiles(
        res.assets.map((a) => ({
          uri: a.uri,
          name: a.name ?? "file",
          type: a.mimeType ?? "application/octet-stream",
        })),
      );
    } catch (e) {
      toastErr("File pick failed", e);
    }
  };

  const pickPhotos = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: MAX_FILES,
        quality: 0.9,
      });
      if (res.canceled) return;
      addFiles(
        res.assets.map((a, i) => ({
          uri: a.uri,
          name: a.fileName ?? `photo-${Date.now()}-${i}.jpg`,
          type: a.mimeType ?? "image/jpeg",
        })),
      );
    } catch (e) {
      toastErr("Photo pick failed", e);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body && files.length === 0) return;
    try {
      await onSend({ text: body, files });
      setText("");
      setFiles([]);
    } catch (e) {
      toastErr("Send failed", e);
    }
  };

  return (
    <View style={[styles.wrap, { paddingBottom: bottomPad }]}>
      {candidates.length > 0 ? (
        <ScrollView horizontal keyboardShouldPersistTaps="always" style={styles.mentionBar}>
          {candidates.map((c) => (
            <Pressable key={c.id} style={styles.mentionChip} onPress={() => insertMention(c)}>
              <Text style={styles.mentionText}>@{slugify(c.name)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {files.length > 0 ? (
        <ScrollView horizontal style={styles.fileBar} keyboardShouldPersistTaps="always">
          {files.map((f, i) => (
            <Pressable
              key={`${f.uri}-${i}`}
              style={styles.fileChip}
              onPress={() => setFiles(files.filter((_, j) => j !== i))}
            >
              <Text style={styles.fileText} numberOfLines={1}>
                {f.name} ✕
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.row}>
        <Pressable onPress={pickDocuments} hitSlop={8} style={styles.iconBtn}>
          <Text style={styles.icon}>📎</Text>
        </Pressable>
        <Pressable onPress={pickPhotos} hitSlop={8} style={styles.iconBtn}>
          <Text style={styles.icon}>🖼️</Text>
        </Pressable>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={setText}
          onSelectionChange={(e) => {
            selection.current = e.nativeEvent.selection;
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          multiline
          maxLength={20_000}
        />
        <Pressable
          onPress={send}
          disabled={sending || (!text.trim() && files.length === 0)}
          style={[styles.sendBtn, (sending || (!text.trim() && files.length === 0)) && styles.sendOff]}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <Text style={styles.sendText}>↑</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  mentionBar: { paddingHorizontal: 12, paddingTop: 8 },
  mentionChip: {
    backgroundColor: "rgba(139,124,255,0.15)",
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginRight: 6,
  },
  mentionText: { color: colors.a1, fontSize: 13, fontWeight: "600" },
  fileBar: { paddingHorizontal: 12, paddingTop: 8 },
  fileChip: {
    backgroundColor: colors.panelStrong,
    borderRadius: 8,
    paddingVertical: 5,
    paddingHorizontal: 10,
    marginRight: 6,
    maxWidth: 180,
  },
  fileText: { color: colors.dim, fontSize: 12.5 },
  row: { flexDirection: "row", alignItems: "flex-end", padding: 10, gap: 8 },
  iconBtn: { paddingBottom: 9 },
  icon: { fontSize: 20 },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    maxHeight: 130,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 9,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  sendOff: { opacity: 0.4 },
  sendText: { color: colors.onAccent, fontSize: 18, fontWeight: "800" },
});
