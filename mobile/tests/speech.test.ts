const mockPause = jest.fn();
const mockRelease = jest.fn();

jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(() => ({
    addListener: jest.fn(),
    pause: mockPause,
    play: jest.fn(),
    release: mockRelease,
  })),
  setAudioModeAsync: jest.fn(async () => {}),
}));

jest.mock("expo-file-system", () => {
  class MockFile {
    uri = "file:///tmp/speech.mp3";
    exists = false;
    delete = jest.fn();
    write = jest.fn();
  }
  return { File: MockFile, Paths: { cache: "file:///tmp" } };
});

import {
  enqueueSpeech,
  onSpeechIdle,
  speechActive,
  stopSpeech,
} from "../src/lib/speech";

const session = {
  baseUrl: "https://agora.example",
  token: "session-token",
} as never;

beforeEach(() => {
  jest.clearAllMocks();
  stopSpeech();
});

test("interrupt cancels natural completion instead of resuming the mic twice", async () => {
  const fetchMock = jest.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  );
  global.fetch = fetchMock as typeof fetch;

  enqueueSpeech(session, 7);
  expect(speechActive()).toBe(true);
  const resumeMic = jest.fn();
  onSpeechIdle(resumeMic);

  stopSpeech();
  await new Promise(resolve => setImmediate(resolve));

  expect(resumeMic).not.toHaveBeenCalled();
  expect(speechActive()).toBe(false);
});

test("interrupt during manifest parsing cannot restore stale chunks", async () => {
  let resolveManifest!: (value: { count: number }) => void;
  const manifest = new Promise<{ count: number }>(resolve => {
    resolveManifest = resolve;
  });
  const fetchMock = jest.fn(async () => ({
    ok: true,
    json: () => manifest,
  }));
  global.fetch = fetchMock as unknown as typeof fetch;

  enqueueSpeech(session, 8);
  await new Promise(resolve => setImmediate(resolve));
  stopSpeech();
  resolveManifest({ count: 2 });
  await new Promise(resolve => setImmediate(resolve));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(speechActive()).toBe(false);
});

test("whole-message fallback is used only for an exact manifest 404", async () => {
  const fetchMock = jest
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 404 })
    .mockResolvedValueOnce({ ok: false, status: 502 });
  global.fetch = fetchMock as typeof fetch;

  enqueueSpeech(session, 9);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(String(fetchMock.mock.calls[1][0])).toContain("/messages/9/speech");
  expect(String(fetchMock.mock.calls[1][0])).not.toContain("/chunks/");
  expect(speechActive()).toBe(false);
});
