/* Speak-aloud (🔊): a personal page-level preference (localStorage
   "agora_speak", synced across tabs) — when on, agent replies are read
   aloud via /speech. The live session has its own playback; while one runs
   this stays out of the way. */

import { create } from "zustand";
import { fetchSpeechUrl, playSpeech, stopAudio, unlockPlayback } from "../lib/voice";
import { toast } from "../lib/toast";

interface SpeakState {
  on: boolean;
  toggle: () => void;
  setFromStorage: (on: boolean) => void;
}

let queue: number[] = [];
let current: HTMLAudioElement | null = null;
let warned = false;

async function next(): Promise<void> {
  const id = queue.shift();
  if (id == null || !useSpeak.getState().on) { current = null; return; }
  let url: string;
  try {
    url = await fetchSpeechUrl(id);
  } catch (e) {
    // Surface "TTS not configured" once instead of failing silently forever.
    const status = (e as Error & { status?: number }).status;
    if (status === 400 && !warned) {
      warned = true;
      toast("Can't speak replies: " + (e as Error).message, { variant: "warn" });
    }
    void next();
    return;
  }
  const done = () => {
    URL.revokeObjectURL(url);
    current = null;
    void next();
  };
  const playing = await playSpeech(url, done);
  if (playing) current = playing;
  else done();
}

export function speakEnqueue(messageId: number): void {
  queue.push(messageId);
  if (!current) void next();
}

export function speakStop(): void {
  queue = [];
  const audio = current;
  current = null;
  stopAudio(audio);
}

export const useSpeak = create<SpeakState>((set, get) => ({
  on: localStorage.getItem("agora_speak") === "on",
  toggle: () => {
    const on = !get().on;
    localStorage.setItem("agora_speak", on ? "on" : "off");
    if (on) void unlockPlayback(); // mobile: unlock before the async reply
    else speakStop();
    set({ on });
  },
  setFromStorage: (on) => {
    if (!on) speakStop();
    set({ on });
  },
}));

// A second open tab must not keep speaking after the toggle turned off
// elsewhere (and vice versa) — the flag is cached per tab.
window.addEventListener("storage", (e) => {
  if (e.key !== "agora_speak") return;
  useSpeak.getState().setFromStorage(e.newValue === "on");
});
