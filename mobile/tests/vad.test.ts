/* The live-voice endpointer: speech onset, silence-based utterance end, and
   noise-blip rejection — fed synthetic metering samples on a fake clock. */

import { VAD, initialVadState, vadStep } from "../src/lib/vad";

const QUIET = -60;
const LOUD = -20;

function feed(
  state: ReturnType<typeof initialVadState>,
  samples: { db: number; at: number }[],
) {
  return samples.map((s) => vadStep(state, s.db, s.at));
}

describe("vadStep", () => {
  test("stays idle through silence", () => {
    const state = initialVadState();
    const actions = feed(state, [
      { db: QUIET, at: 0 },
      { db: QUIET, at: 120 },
      { db: QUIET, at: 240 },
    ]);
    expect(actions.every((a) => a.kind === "none" && !a.speaking)).toBe(true);
  });

  test("undefined metering (no permission yet) never starts an utterance", () => {
    const state = initialVadState();
    expect(vadStep(state, undefined, 0).kind).toBe("none");
  });

  test("speech onset starts, silence gap ends a sendable utterance", () => {
    const state = initialVadState();
    expect(vadStep(state, LOUD, 0).kind).toBe("start");
    // Voiced past MIN_UTTER_MS…
    expect(vadStep(state, LOUD, VAD.MIN_UTTER_MS + 100).kind).toBe("none");
    // …then quiet, but not long enough to end yet.
    expect(vadStep(state, QUIET, VAD.MIN_UTTER_MS + 300).kind).toBe("none");
    const end = vadStep(state, QUIET, VAD.MIN_UTTER_MS + 100 + VAD.SILENCE_MS);
    expect(end).toEqual({ kind: "end", sendable: true });
    expect(state.speaking).toBe(false);
  });

  test("a short blip ends as non-sendable", () => {
    const state = initialVadState();
    vadStep(state, LOUD, 0); // start
    vadStep(state, QUIET, 100); // quiet after only 100ms of voice
    const end = vadStep(state, QUIET, VAD.SILENCE_MS);
    expect(end).toEqual({ kind: "end", sendable: false });
  });

  test("continued speech keeps extending the utterance", () => {
    const state = initialVadState();
    vadStep(state, LOUD, 0);
    // Alternating voice keeps lastVoice fresh, so no end fires.
    for (let t = 100; t <= 2000; t += 100) {
      const a = vadStep(state, t % 400 === 0 ? QUIET : LOUD, t);
      expect(a.kind).toBe("none");
    }
    const end = vadStep(state, QUIET, 2000 + VAD.SILENCE_MS);
    expect(end).toEqual({ kind: "end", sendable: true });
  });

  test("threshold boundary: exactly at threshold counts as voice", () => {
    const state = initialVadState();
    expect(vadStep(state, VAD.THRESHOLD_DB, 0).kind).toBe("start");
    const state2 = initialVadState();
    expect(vadStep(state2, VAD.THRESHOLD_DB - 0.1, 0).kind).toBe("none");
  });
});
