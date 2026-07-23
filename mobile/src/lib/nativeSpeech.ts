/* Manual, on-device message speech. This is deliberately separate from
   speech.ts: automatic agent replies use authenticated server-generated
   audio, while a user-selected message should work without server TTS. */

import * as Speech from "expo-speech";
import type { Message } from "@agora/core";
import { stopSpeech } from "./speech";

/** Speak the complete stored message, regardless of whether its TL;DR is
    currently displayed. Returns false when the message has no spoken text. */
export async function speakMessage(
  message: Pick<Message, "text">,
  onError?: (error: Error) => void,
): Promise<boolean> {
  if (!message.text.trim()) return false;

  // Never let server audio and the system synthesizer talk over each other.
  stopSpeech();
  await Speech.stop();
  Speech.speak(message.text, {
    useApplicationAudioSession: false,
    onError,
  });
  return true;
}
