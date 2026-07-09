/* TTS playback: streams GET /api/messages/{id}/speech (MP3) with the auth
   header, one clip at a time, FIFO. Used by the 🔊 speak-aloud toggle and the
   live voice screen. Module-level singleton — playback outlives any one
   screen, and two screens must never talk over each other. */

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { authHeaders, type Session } from "../api/client";

let queue: { session: Session; messageId: number }[] = [];
let player: AudioPlayer | null = null;
let onIdleOnce: (() => void) | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;

/** expo-audio has no error event on the player; a clip that never finishes
    (failed TTS fetch, bad audio) must not wedge the queue forever. */
const CLIP_TIMEOUT_MS = 180_000;

/** TTS must sound with the mute switch on — a spoken reply the user asked
    for is not a notification sound. */
export async function prepareSpeechAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
  } catch {
    /* non-fatal: playback still works with the switch off */
  }
}

export function speechUrl(session: Session, messageId: number): string {
  return `${session.baseUrl}/api/messages/${messageId}/speech`;
}

export function enqueueSpeech(session: Session, messageId: number): void {
  queue.push({ session, messageId });
  if (!player) playNext();
}

export function speechActive(): boolean {
  return player !== null || queue.length > 0;
}

/** Stop mid-clip and drop the backlog. `onIdle` (from stopSpeech below)
    fires once everything is torn down. */
export function stopSpeech(): void {
  queue = [];
  releasePlayer();
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
}

function fireIdle(): void {
  const fn = onIdleOnce;
  onIdleOnce = null;
  fn?.();
}

function playNext(): void {
  const next = queue.shift();
  if (!next) {
    releasePlayer();
    fireIdle();
    return;
  }
  releasePlayer();
  try {
    const p = createAudioPlayer({
      uri: speechUrl(next.session, next.messageId),
      headers: authHeaders(next.session),
    });
    player = p;
    p.addListener("playbackStatusUpdate", (status) => {
      if (player !== p) return;
      if (status.didJustFinish) playNext();
    });
    watchdog = setTimeout(() => {
      if (player === p) playNext();
    }, CLIP_TIMEOUT_MS);
    p.play();
  } catch {
    // Unspeakable message (TTS off, empty text) — keep the queue moving.
    player = null;
    playNext();
  }
}
