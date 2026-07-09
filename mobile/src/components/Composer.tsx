/* Message composer: text, attachments (max 5, like the server), voice notes
   (🎤 → transcribed server-side), and @mention autocomplete over the
   channel's live agents + group members. */

import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
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
  onSendVoice,
}: {
  placeholder: string;
  mentions: MentionCandidate[];
  sending: boolean;
  onSend: (v: { text: string; files: OutgoingFile[] }) => Promise<void>;
  /** When set (server has voice), a 🎤 button records a voice note and hands
      the file here for the transcribe-and-post upload. */
  onSendVoice?: (file: OutgoingFile) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<OutgoingFile[]>([]);
  const [focused, setFocused] = useState(false);
  const [attachSheet, setAttachSheet] = useState(false);
  const selection = useRef({ start: 0, end: 0 });
  const inputRef = useRef<TextInput>(null);

  /* iOS can't present the native picker while the attach-sheet Modal is
     still dismissing — the launch is silently dropped. Stash the action and
     run it from the Modal's onDismiss (fires after dismissal completes).
     Android has no such race, so run immediately there. */
  const pendingPick = useRef<(() => void) | null>(null);
  const closeSheet = (action?: () => void) => {
    setAttachSheet(false);
    if (!action) return;
    if (Platform.OS === "ios") {
      pendingPick.current = action;
    } else {
      action();
    }
  };
  const onSheetDismissed = () => {
    const action = pendingPick.current;
    pendingPick.current = null;
    action?.();
  };

  /* Voice note recording. The recorder hook is unconditional (hooks rule);
     nothing touches the mic until the 🎤 tap. */
  const [recPhase, setRecPhase] = useState<"idle" | "recording" | "uploading">("idle");
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recState = useAudioRecorderState(recorder, 500);

  const startRec = async () => {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        toast("Microphone access is needed for voice messages", "warn");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecPhase("recording");
    } catch (e) {
      toastErr("Couldn't start recording", e);
    }
  };

  const stopRec = async (): Promise<string | null> => {
    try {
      await recorder.stop();
    } catch {
      /* already stopped */
    }
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    return recorder.uri;
  };

  const cancelRec = async () => {
    await stopRec();
    setRecPhase("idle");
  };

  const finishRec = async () => {
    const tooShort = (recState.durationMillis ?? 0) < 500;
    const uri = await stopRec();
    if (!uri || tooShort) {
      if (tooShort) toast("Recording too short", "warn");
      setRecPhase("idle");
      return;
    }
    setRecPhase("uploading");
    try {
      await onSendVoice?.({
        uri,
        name: `voice-note-${Date.now()}.m4a`,
        type: "audio/m4a",
      });
    } catch (e) {
      toastErr("Voice message failed", e);
    }
    setRecPhase("idle");
  };

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

  const takePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        toast("Camera access is needed to take photos", "warn");
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
      if (res.canceled) return;
      addFiles(
        res.assets.map((a, i) => ({
          uri: a.uri,
          name: a.fileName ?? `photo-${Date.now()}-${i}.jpg`,
          type: a.mimeType ?? "image/jpeg",
        })),
      );
    } catch (e) {
      toastErr("Camera failed", e);
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

  if (recPhase !== "idle") {
    const secs = Math.floor((recState.durationMillis ?? 0) / 1000);
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    return (
      <View style={[styles.wrap, { paddingBottom: bottomPad }]}>
        <View style={styles.row}>
          <View style={styles.recDot} />
          <Text style={styles.recTime}>
            {recPhase === "uploading" ? "Transcribing…" : clock}
          </Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={cancelRec} disabled={recPhase === "uploading"} style={styles.recCancel}>
            <Text style={styles.recCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={finishRec}
            disabled={recPhase === "uploading"}
            style={[styles.sendBtn, recPhase === "uploading" && styles.sendOff]}
          >
            {recPhase === "uploading" ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.sendText}>↑</Text>
            )}
          </Pressable>
        </View>
      </View>
    );
  }

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
      {/* Slack-style: collapsed = one pill row (+ | input | 🎤); focused =
          full-width input with a toolbar row underneath. The TextInput keeps
          a stable key so refocusing/layout swaps never remount it (which
          would drop the keyboard). */}
      <View style={focused ? styles.colFocused : styles.row}>
        {!focused ? (
          <Pressable onPress={() => setAttachSheet(true)} hitSlop={8} style={styles.plusBtn}>
            <Text style={styles.plusText}>+</Text>
          </Pressable>
        ) : null}
        <TextInput
          key="composer-input"
          ref={inputRef}
          style={focused ? styles.inputFocused : styles.input}
          value={text}
          onChangeText={setText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSelectionChange={(e) => {
            selection.current = e.nativeEvent.selection;
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          multiline
          maxLength={20_000}
        />
        {/* Collapsed with a draft pending (e.g. after the picker stole focus):
            swap the mic for a send button so the draft isn't stranded. */}
        {!focused && (text.trim() || files.length > 0) ? (
          <Pressable
            onPress={send}
            disabled={sending}
            style={[styles.sendBtn, sending && styles.sendOff]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Text style={styles.sendText}>↑</Text>
            )}
          </Pressable>
        ) : !focused && onSendVoice ? (
          <Pressable onPress={startRec} hitSlop={8} style={styles.iconBtn}>
            <Text style={styles.icon}>🎤</Text>
          </Pressable>
        ) : null}
      </View>
      {focused ? (
        <View style={styles.toolbar}>
          <Pressable onPress={() => setAttachSheet(true)} hitSlop={8} style={styles.plusBtn}>
            <Text style={styles.plusText}>+</Text>
          </Pressable>
          <Pressable onPress={pickPhotos} hitSlop={8} style={styles.toolBtn}>
            <Text style={styles.icon}>🖼️</Text>
          </Pressable>
          {onSendVoice ? (
            <Pressable onPress={startRec} hitSlop={8} style={styles.toolBtn}>
              <Text style={styles.icon}>🎤</Text>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }} />
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
      ) : null}
      {attachSheet ? (
        <Modal
          transparent
          animationType="fade"
          onRequestClose={() => closeSheet()}
          onDismiss={onSheetDismissed}
        >
          <Pressable style={styles.sheetBackdrop} onPress={() => closeSheet()}>
            <View style={styles.sheet}>
              <Pressable style={styles.sheetBtn} onPress={() => closeSheet(() => void pickPhotos())}>
                <Text style={styles.sheetText}>🖼️ Photo library</Text>
              </Pressable>
              <Pressable style={styles.sheetBtn} onPress={() => closeSheet(() => void takePhoto())}>
                <Text style={styles.sheetText}>📷 Camera</Text>
              </Pressable>
              <Pressable style={styles.sheetBtn} onPress={() => closeSheet(() => void pickDocuments())}>
                <Text style={styles.sheetText}>📎 Document</Text>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      ) : null}
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
  colFocused: { paddingHorizontal: 12, paddingTop: 8 },
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
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
  },
  /* Focused: the input sheds its pill and spans the full width; the actions
     move into the toolbar row below (Slack's expanded composer). */
  inputFocused: {
    color: colors.text,
    fontSize: 15.5,
    minHeight: 40,
    maxHeight: 150,
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 6,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingTop: 2,
    paddingBottom: 8,
  },
  toolBtn: { padding: 2 },
  plusBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
    marginBottom: 2,
  },
  plusText: { color: colors.dim, fontSize: 20, fontWeight: "600", lineHeight: 24 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#14161d",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    gap: 4,
    paddingBottom: 34,
  },
  sheetBtn: { paddingVertical: 13 },
  sheetText: { color: colors.text, fontSize: 15.5 },
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
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.red,
    alignSelf: "center",
    marginLeft: 4,
  },
  recTime: {
    color: colors.text,
    fontSize: 15,
    fontVariant: ["tabular-nums"],
    alignSelf: "center",
    marginLeft: 8,
  },
  recCancel: { alignSelf: "center", paddingHorizontal: 12, paddingVertical: 8 },
  recCancelText: { color: colors.dim, fontSize: 14.5, fontWeight: "600" },
});
