/* Shared audio plumbing for the voice features: recorder mime picking, the
   reusable TTS player with its autoplay unlock, and the /voice upload.
   Server side: POST /api/channels/{id}/voice (STT) and
   GET /api/messages/{id}/speech (TTS); both need OPENAI_API_KEY there. */

import { sessionToken } from "./auth";
import { toast } from "./toast";

export function recMime(): string {
  // Chrome/Firefox record webm/opus; Safari records mp4 (AAC). Both are
  // accepted by the transcription API.
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

export function voiceSupported(): boolean {
  return !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";
}

/* One reused element for TTS — iOS needs playsInline and a gesture unlock. */
let _player: HTMLAudioElement | null = null;
let _playWarned = false;
let _playbackGeneration = 0;
let _cancelPlayback: (() => void) | null = null;

export function player(): HTMLAudioElement {
  if (!_player) {
    _player = new Audio();
    _player.setAttribute("playsinline", "");
    (_player as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
  }
  return _player;
}

/* Mobile browsers (especially iOS Safari) block audio.play() unless the page
   has been "unlocked" by a recent user gesture — call from 🔊 / 🎧 taps. */
export async function unlockPlayback(): Promise<void> {
  const p = player();
  // Tiny silent WAV — just enough to satisfy the autoplay gate.
  p.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
  try {
    await p.play();
    p.pause();
    p.currentTime = 0;
    p.removeAttribute("src");
    p.load();
  } catch { /* still try playback later */ }
}

export async function playSpeech(
  url: string,
  onDone: () => void,
  onError: () => void = onDone,
): Promise<HTMLAudioElement | null> {
  const audio = player();
  audio.onended = null;
  audio.onerror = null;
  audio.src = url;
  let settled = false;
  const settle = (callback: () => void) => {
    if (settled) return;
    settled = true;
    audio.onended = null;
    audio.onerror = null;
    callback();
  };
  const done = () => settle(onDone);
  const failed = () => settle(onError);
  audio.onended = done;
  audio.onerror = failed;
  try {
    await audio.play();
    return audio;
  } catch {
    if (!_playWarned) {
      _playWarned = true;
      toast("Couldn't play the reply — tap the speaker or Live button again to allow sound on this device",
        { variant: "warn" });
    }
    failed();
    return null;
  }
}

export function stopAudio(audio: HTMLAudioElement | null): void {
  _playbackGeneration++;
  _cancelPlayback?.();
  _cancelPlayback = null;
  const a = audio || (_player && !_player.paused ? _player : null);
  if (!a) return;
  a.onended = null;
  a.onerror = null;
  try { a.pause(); } catch { /* already stopped */ }
  if (a.src && a.src.startsWith("blob:")) URL.revokeObjectURL(a.src);
}

function timezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

/** Upload a recording to /voice; the server transcribes and posts the
    message (the WS echo delivers it to every client, including us). */
export async function uploadVoice(v: {
  channelId: string;
  threadId: number | null;
  blob: Blob;
  live?: boolean;
}): Promise<void> {
  const type = (v.blob.type || "audio/webm").toLowerCase();
  // The transcription API infers the codec from the file extension.
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const fd = new FormData();
  fd.append("file", v.blob, (v.live ? "utterance." : "voice-note.") + ext);
  if (v.live) fd.append("live", "true");
  if (v.threadId != null) fd.append("thread_id", String(v.threadId));
  const tz = timezone();
  if (tz) fd.append("timezone", tz);
  const res = await fetch(`/api/channels/${encodeURIComponent(v.channelId)}/voice`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken()}` },
    body: fd,
  });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch { /* plain text */ }
    throw new Error(detail);
  }
}

async function fetchSpeechPath(path: string): Promise<string> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${sessionToken()}` },
  });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch { /* plain text */ }
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return URL.createObjectURL(await res.blob());
}

export async function fetchSpeechUrl(messageId: number, chunkIndex?: number): Promise<string> {
  const suffix = chunkIndex == null ? "" : `/chunks/${chunkIndex}`;
  return fetchSpeechPath(`/api/messages/${messageId}/speech${suffix}`);
}

async function fetchSpeechChunkCount(messageId: number): Promise<number> {
  const res = await fetch(`/api/messages/${messageId}/speech/manifest`, {
    headers: { Authorization: `Bearer ${sessionToken()}` },
  });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail).detail || detail; } catch { /* plain text */ }
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const count = Number((await res.json()).count);
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid speech manifest");
  return count;
}

/** Play one message sentence-by-sentence on the same audio element that the
    user's gesture unlocked. The next chunk downloads during current playback;
    older servers fall back to the compatibility whole-message endpoint. */
export async function playMessageSpeech(
  messageId: number,
  onDone: () => void,
): Promise<HTMLAudioElement | null> {
  _cancelPlayback?.();
  const generation = ++_playbackGeneration;
  const urls = new Set<string>();
  const releaseUrl = (url: string) => {
    urls.delete(url);
    URL.revokeObjectURL(url);
  };
  const cancel = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  _cancelPlayback = cancel;
  const track = async (promise: Promise<string>): Promise<string | null> => {
    const url = await promise;
    if (generation !== _playbackGeneration) {
      URL.revokeObjectURL(url);
      return null;
    }
    urls.add(url);
    return url;
  };
  const finish = () => {
    if (generation !== _playbackGeneration) return;
    // Invalidate in-flight prefetches before clearing the URLs already known.
    _playbackGeneration++;
    cancel();
    if (_cancelPlayback === cancel) _cancelPlayback = null;
    onDone();
  };
  let count: number;
  try {
    count = await fetchSpeechChunkCount(messageId);
  } catch (e) {
    if (generation !== _playbackGeneration) return null;
    if ((e as Error & { status?: number }).status !== 404) {
      cancel();
      _cancelPlayback = null;
      throw e;
    }
    let url: string | null;
    try {
      url = await track(fetchSpeechUrl(messageId));
    } catch (error) {
      cancel();
      if (_cancelPlayback === cancel) _cancelPlayback = null;
      throw error;
    }
    if (!url) return null;
    const done = () => {
      releaseUrl(url);
      finish();
    };
    return playSpeech(url, done, done);
  }

  const playChunk = async (
    index: number,
    ready?: Promise<string | null>,
  ): Promise<HTMLAudioElement | null> => {
    if (generation !== _playbackGeneration) return null;
    if (index >= count) {
      finish();
      return null;
    }
    let url: string | null;
    try {
      url = await (ready ?? track(fetchSpeechUrl(messageId, index)));
    } catch {
      return playChunk(index + 1);
    }
    if (!url) return playChunk(index + 1);
    if (generation !== _playbackGeneration) {
      releaseUrl(url);
      return null;
    }
    const next = index + 1 < count
      ? track(fetchSpeechUrl(messageId, index + 1)).catch(() => null)
      : undefined;
    return playSpeech(url, () => {
      releaseUrl(url);
      void playChunk(index + 1, next);
    }, () => {
      releaseUrl(url);
      finish();
    });
  };
  return playChunk(0);
}
