/* Utterance endpointing for live voice: a tiny state machine fed the
   recorder's metering samples (dBFS, ~-160..0). Speech starts when the level
   crosses the threshold, and the utterance ends after a silence gap — the
   same scheme as the web UI's RMS loop, kept pure so it's testable. */

export const VAD = {
  /** Speech threshold in dBFS on the mic signal. */
  THRESHOLD_DB: -35,
  /** Utterance ends after this much quiet. */
  SILENCE_MS: 800,
  /** Shorter blips are coughs/taps — dropped without a network round-trip. */
  MIN_UTTER_MS: 300,
};

export type VadAction =
  | { kind: "none"; speaking: boolean }
  | { kind: "start" }
  | { kind: "end"; sendable: boolean };

export interface VadState {
  speaking: boolean;
  utterStart: number;
  lastVoice: number;
}

export function initialVadState(): VadState {
  return { speaking: false, utterStart: 0, lastVoice: 0 };
}

/** Feed one metering sample; mutates `state` and says what the caller should
    do (start capturing / stop and maybe send / nothing). */
export function vadStep(
  state: VadState,
  meteringDb: number | undefined,
  nowMs: number,
  config: typeof VAD = VAD,
): VadAction {
  const voiced = meteringDb !== undefined && meteringDb >= config.THRESHOLD_DB;
  if (!state.speaking) {
    if (!voiced) return { kind: "none", speaking: false };
    state.speaking = true;
    state.utterStart = nowMs;
    state.lastVoice = nowMs;
    return { kind: "start" };
  }
  if (voiced) state.lastVoice = nowMs;
  if (nowMs - state.lastVoice < config.SILENCE_MS) {
    return { kind: "none", speaking: true };
  }
  const sendable = state.lastVoice - state.utterStart >= config.MIN_UTTER_MS;
  state.speaking = false;
  return { kind: "end", sendable };
}
