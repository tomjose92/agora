/* TTS playback: downloads authenticated sentence MP3s to short-lived local
   files, then plays them FIFO. Used by the 🔊 speak-aloud toggle and live
   voice. Module-level singleton — playback outlives any one screen, and two
   screens must never talk over each other. */

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { authHeaders, type Session } from "@agora/core";

type SpeechItem =
  | { kind: "message"; session: Session; messageId: number }
  | { kind: "clip"; session: Session; messageId: number; chunkIndex: number | null };

let queue: SpeechItem[] = [];
let player: AudioPlayer | null = null;
let resolving = false;
let generation = 0;
let onIdleOnce: (() => void) | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let activeFetch: AbortController | null = null;
let currentFile: File | null = null;
let currentBlobUrl: string | null = null;

/** expo-audio has no error event on the player; a clip that never finishes
    (failed TTS fetch, bad audio) must not wedge the queue forever. */
const CLIP_TIMEOUT_MS = 180_000;
const MANIFEST_TIMEOUT_MS = 15_000;
// The server's upstream TTS timeout is 120s. Leave enough room for it to
// return a controlled 502 instead of aborting a legitimate cold-cache chunk.
const CLIP_FETCH_TIMEOUT_MS = 135_000;

/** TTS must sound with the mute switch on — a spoken reply the user asked
    for is not a notification sound — and must keep playing when the phone
    locks mid-reply (UIBackgroundModes audio is enabled in app.json). */
export async function prepareSpeechAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true });
  } catch {
    /* non-fatal: playback still works with the switch off */
  }
}

export function speechUrl(session: Session, messageId: number, chunkIndex: number | null = null): string {
  const suffix = chunkIndex == null ? "" : `/chunks/${chunkIndex}`;
  return `${session.baseUrl}/api/messages/${messageId}/speech${suffix}`;
}

export function enqueueSpeech(session: Session, messageId: number): void {
  queue.push({ kind: "message", session, messageId });
  if (!player && !resolving) void playNext();
}

export function speechActive(): boolean {
  return player !== null || resolving || queue.length > 0;
}

/** Stop mid-clip and drop the backlog. Natural-completion callbacks are
    cancelled; the interrupting screen owns its explicit resume action. */
export function stopSpeech(): void {
  generation++;
  activeFetch?.abort();
  activeFetch = null;
  queue = [];
  resolving = false;
  releasePlayer();
  // An interrupting live screen resumes its mic explicitly. Firing the queued
  // natural-completion callback here would start the same recorder twice.
  onIdleOnce = null;
}

/** Run `fn` when the current clip (and backlog) finishes — or now if idle.
    The live screen uses this to resume the mic after a reply is spoken. */
export function onSpeechIdle(fn: () => void): void {
  if (!speechActive()) {
    fn();
    return;
  }
  onIdleOnce = fn;
}

function releasePlayer(): void {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
  const p = player;
  player = null;
  if (p) {
    try {
      p.pause();
      p.release();
    } catch {
      /* already released */
    }
  }
  const file = currentFile;
  currentFile = null;
  if (file?.exists) {
    try { file.delete(); } catch { /* best-effort cache cleanup */ }
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

function fireIdle(): void {
  const fn = onIdleOnce;
  onIdleOnce = null;
  fn?.();
}

async function playNext(): Promise<void> {
  const next = queue.shift();
  if (!next) {
    releasePlayer();
    fireIdle();
    return;
  }
  releasePlayer();
  if (next.kind === "message") {
    resolving = true;
    const currentGeneration = generation;
    const controller = new AbortController();
    activeFetch = controller;
    const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${next.session.baseUrl}/api/messages/${next.messageId}/speech/manifest`,
        { headers: authHeaders(next.session), signal: controller.signal },
      );
      if (currentGeneration !== generation) return;
      if (res.ok) {
        const count = Number((await res.json()).count);
        if (currentGeneration !== generation) return;
        if (Number.isInteger(count) && count > 0) {
          const chunks: SpeechItem[] = Array.from({ length: count }, (_, chunkIndex) => ({
            kind: "clip",
            session: next.session,
            messageId: next.messageId,
            chunkIndex,
          }));
          queue.unshift(...chunks);
        }
      } else if (res.status === 404) {
        // Compatibility with a server that predates sentence manifests.
        queue.unshift({ ...next, kind: "clip", chunkIndex: null });
      }
    } catch {
      // A timeout or transient network failure skips this reply. Whole-message
      // fallback is reserved for a definitive 404 from an older server.
    } finally {
      clearTimeout(timeout);
      if (activeFetch === controller) activeFetch = null;
      if (currentGeneration === generation) {
        resolving = false;
        void playNext();
      }
    }
    return;
  }
  resolving = true;
  const currentGeneration = generation;
  const controller = new AbortController();
  activeFetch = controller;
  const timeout = setTimeout(() => controller.abort(), CLIP_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(speechUrl(next.session, next.messageId, next.chunkIndex), {
      headers: authHeaders(next.session),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Speech request failed (${res.status})`);
    let uri: string;
    if (Platform.OS === "web") {
      const blobUrl = URL.createObjectURL(await res.blob());
      if (currentGeneration !== generation) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      currentBlobUrl = blobUrl;
      uri = blobUrl;
    } else {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (currentGeneration !== generation) return;
      const file = new File(
        Paths.cache,
        `agora-speech-${currentGeneration}-${next.messageId}-${next.chunkIndex ?? "whole"}.mp3`,
      );
      if (file.exists) file.delete();
      file.write(bytes);
      currentFile = file;
      uri = file.uri;
    }
    resolving = false;
    if (activeFetch === controller) activeFetch = null;
    const p = createAudioPlayer({
      uri,
    });
    player = p;
    p.addListener("playbackStatusUpdate", (status) => {
      if (player !== p) return;
      if (status.didJustFinish) void playNext();
    });
    watchdog = setTimeout(() => {
      if (player === p) {
        // expo-audio exposes no load error. Treat one watchdog expiry as a
        // failure of this reply, not N independent three-minute failures.
        queue = queue.filter(item => item.messageId !== next.messageId);
        void playNext();
      }
    }, CLIP_TIMEOUT_MS);
    p.play();
  } catch {
    // Unspeakable message (TTS off, empty text) — keep the queue moving.
    if (currentGeneration !== generation) return;
    resolving = false;
    if (activeFetch === controller) activeFetch = null;
    releasePlayer();
    void playNext();
  } finally {
    clearTimeout(timeout);
  }
}
