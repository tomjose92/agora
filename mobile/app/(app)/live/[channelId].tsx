/* Live voice: a hands-free, full-screen conversation loop for one channel —
   or, when opened from a thread, for that one thread (turns post as replies
   under the root) — the mobile counterpart of the web UI's 🎧 Live strip.

   Half-duplex cascade: the mic records continuously and a metering-based VAD
   (src/lib/vad.ts) endpoints each utterance; the clip goes to /voice?live=true
   (server transcribes and posts it; agents are steered to answer in spoken
   prose), and the reply is fetched from /speech and played. The mic stays off
   while audio plays — phone speakers feed the mic straight back, and expo-audio
   has no echo cancellation — so barge-in is "tap to interrupt" rather than
   talk-over. */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { Headphones } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSendVoice } from "../../../src/api/queries";
import { Icon } from "../../../src/components/Icon";
import { toast } from "../../../src/components/Toast";
import { onAgentMessage } from "../../../src/lib/agentBus";
import {
  enqueueSpeech,
  onSpeechIdle,
  prepareSpeechAudio,
  stopSpeech,
} from "../../../src/lib/speech";
import { colors } from "../../../src/lib/theme";
import { initialVadState, vadStep } from "../../../src/lib/vad";
import { useSession } from "../../../src/state/session";

type LiveStatus = "starting" | "listening" | "recording" | "thinking" | "speaking" | "error";

const LABELS: Record<LiveStatus, string> = {
  starting: "Starting…",
  listening: "Listening — just talk",
  recording: "Recording…",
  thinking: "Thinking…",
  speaking: "Speaking — tap to interrupt",
  error: "Microphone unavailable",
};

/** A silent listening stretch longer than this recycles the recorder so idle
    sessions don't accumulate a huge file between utterances. */
const IDLE_RECYCLE_MS = 45_000;
const TURN_TIMEOUT_MS = 60_000; // same safety valve as the web loop

export default function LiveScreen() {
  const params = useLocalSearchParams<{
    channelId: string;
    channelName?: string;
    rootId?: string;
    rootSnippet?: string;
  }>();
  const channelId = params.channelId;
  // Thread-scoped session: turns post as replies under this root, and only
  // that thread's agent replies close the turn (same rule as the web UI).
  const threadId = params.rootId ? Number(params.rootId) : null;
  const session = useSession((s) => s.session)!;
  const sendVoice = useSendVoice(channelId);
  const insets = useSafeAreaInsets();
  useKeepAwake();

  const [status, setStatus] = useState<LiveStatus>("starting");
  const statusRef = useRef(status);
  statusRef.current = status;

  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recorderState = useAudioRecorderState(recorder, 120);

  const vad = useRef(initialVadState());
  const ended = useRef(false);
  const turnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* -------------------------------------------------- mic control */

  const startMic = useCallback(async () => {
    if (ended.current) return;
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      vad.current = initialVadState();
      setStatus("listening");
    } catch {
      setStatus("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopMic = useCallback(async (): Promise<string | null> => {
    try {
      await recorder.stop();
    } catch {
      /* not recording */
    }
    return recorder.uri;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------------------------------------- session lifecycle */

  useEffect(() => {
    ended.current = false;
    void (async () => {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setStatus("error");
        return;
      }
      await prepareSpeechAudio();
      await startMic();
    })();
    return () => {
      ended.current = true;
      if (turnTimer.current) clearTimeout(turnTimer.current);
      stopSpeech();
      void stopMic().then(() =>
        setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {}),
      );
    };
  }, [startMic, stopMic]);

  /* -------------------------------------------------- turn upload */

  const sendUtterance = useCallback(
    async (uri: string) => {
      setStatus("thinking");
      if (turnTimer.current) clearTimeout(turnTimer.current);
      // A channel with no live agents (or a dropped reply) must not wedge the
      // session in "thinking" forever.
      turnTimer.current = setTimeout(() => {
        if (!ended.current && statusRef.current === "thinking") void startMic();
      }, TURN_TIMEOUT_MS);
      try {
        await sendVoice.mutateAsync({
          file: { uri, name: `live-${Date.now()}.m4a`, type: "audio/m4a" },
          threadId,
          live: true,
        });
      } catch (e) {
        if (ended.current) return;
        toast(e instanceof Error ? e.message : "Voice turn failed", "warn");
        if (turnTimer.current) clearTimeout(turnTimer.current);
        void startMic();
      }
    },
    [sendVoice, startMic, threadId],
  );

  /* -------------------------------------------------- VAD loop
     Runs on every metering poll (~120ms). Only the listening/recording
     states feed the endpointer; thinking/speaking keep the mic stopped. */

  useEffect(() => {
    const st = statusRef.current;
    if (ended.current || (st !== "listening" && st !== "recording")) return;
    const action = vadStep(vad.current, recorderState.metering, Date.now());
    if (action.kind === "start") {
      setStatus("recording");
    } else if (action.kind === "end") {
      void (async () => {
        const uri = await stopMic();
        if (ended.current) return;
        if (action.sendable && uri) {
          await sendUtterance(uri);
        } else {
          await startMic(); // noise blip — arm a fresh recording
        }
      })();
    } else if (
      st === "listening" &&
      (recorderState.durationMillis ?? 0) > IDLE_RECYCLE_MS
    ) {
      void stopMic().then(() => startMic());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorderState]);

  /* -------------------------------------------------- agent replies
     Only replies in this session's scope close the turn and get spoken —
     channel sessions take top-level replies, thread sessions their thread's.
     Same scoping as the web session. */

  useEffect(() => {
    return onAgentMessage((m) => {
      if (ended.current || m.channel_id !== channelId) return;
      if ((m.thread_id ?? null) !== threadId) return;
      if (turnTimer.current) clearTimeout(turnTimer.current);
      void (async () => {
        await stopMic(); // half-duplex: never record our own playback
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
          () => {},
        );
        if (ended.current) return;
        setStatus("speaking");
        enqueueSpeech(session, m.id);
        onSpeechIdle(() => {
          if (!ended.current) void startMic();
        });
      })();
    });
  }, [channelId, threadId, session, startMic, stopMic]);

  /* -------------------------------------------------- UI */

  const interrupt = () => {
    if (statusRef.current !== "speaking") return;
    stopSpeech();
    void startMic();
  };

  // Mic level drives the orb size: -60dB..0dB → 1.0..1.5 scale.
  const db = recorderState.metering ?? -60;
  const level = Math.max(0, Math.min(1, (db + 60) / 60));
  const active = status === "listening" || status === "recording";
  const scale = active ? 1 + level * 0.5 : 1;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Pressable style={[styles.root, { paddingTop: insets.top + 18 }]} onPress={interrupt}>
        {threadId != null ? (
          <>
            <Text style={styles.channel}>
              Thread · # {params.channelName || channelId}
            </Text>
            {params.rootSnippet ? (
              <Text style={styles.rootSnippet} numberOfLines={2}>
                {params.rootSnippet}
              </Text>
            ) : null}
          </>
        ) : (
          <View style={styles.channelRow}>
            <Icon icon={Headphones} size={16} />
            <Text style={styles.channel}># {params.channelName || channelId}</Text>
          </View>
        )}
        <View style={styles.center}>
          <View
            style={[
              styles.orb,
              status === "recording" && styles.orbRecording,
              status === "thinking" && styles.orbThinking,
              status === "speaking" && styles.orbSpeaking,
              { transform: [{ scale }] },
            ]}
          />
          <Text style={styles.status}>{LABELS[status]}</Text>
          {status === "error" ? (
            <Text style={styles.errorHint}>
              Allow microphone access in Settings, then try again.
            </Text>
          ) : null}
        </View>
        <Pressable
          style={[styles.endBtn, { marginBottom: insets.bottom + 22 }]}
          onPress={() => router.back()}
        >
          <Text style={styles.endText}>End</Text>
        </Pressable>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: "center" },
  channelRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  channel: { color: colors.dim, fontSize: 14.5, fontWeight: "700" },
  rootSnippet: {
    color: colors.dim,
    fontSize: 12.5,
    marginTop: 6,
    paddingHorizontal: 36,
    textAlign: "center",
    opacity: 0.8,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 34 },
  orb: {
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: colors.accent,
    opacity: 0.9,
  },
  orbRecording: { backgroundColor: colors.red },
  orbThinking: { backgroundColor: colors.amber, opacity: 0.6 },
  orbSpeaking: { backgroundColor: colors.a1 },
  status: { color: colors.text, fontSize: 16.5, fontWeight: "600" },
  errorHint: {
    color: colors.dim,
    fontSize: 13.5,
    textAlign: "center",
    paddingHorizontal: 40,
  },
  endBtn: {
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 24,
    paddingVertical: 12,
    paddingHorizontal: 44,
  },
  endText: { color: colors.text, fontSize: 15.5, fontWeight: "700" },
});
