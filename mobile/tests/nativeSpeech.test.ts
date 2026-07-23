jest.mock(
  "expo-speech",
  () => ({
    speak: jest.fn(),
    stop: jest.fn(async () => {}),
  }),
  { virtual: true },
);
jest.mock("../src/lib/speech", () => ({
  stopSpeech: jest.fn(),
}));

import { speakMessage } from "../src/lib/nativeSpeech";

const native = jest.requireMock("expo-speech") as {
  speak: jest.Mock;
  stop: jest.Mock;
};
const server = jest.requireMock("../src/lib/speech") as {
  stopSpeech: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("speaks the complete stored message after stopping existing audio", async () => {
  const text = "# Full answer\n\nEvery word, **including** markdown.";

  await expect(speakMessage({ text })).resolves.toBe(true);

  expect(server.stopSpeech).toHaveBeenCalledTimes(1);
  expect(native.stop).toHaveBeenCalledTimes(1);
  expect(native.speak).toHaveBeenCalledWith(
    text,
    expect.objectContaining({ useApplicationAudioSession: false }),
  );
  expect(native.stop.mock.invocationCallOrder[0]).toBeLessThan(
    native.speak.mock.invocationCallOrder[0],
  );
});

test("does nothing for a message without spoken text", async () => {
  await expect(speakMessage({ text: " \n\t " })).resolves.toBe(false);

  expect(server.stopSpeech).not.toHaveBeenCalled();
  expect(native.stop).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});

test("passes native synthesis errors to the caller", async () => {
  const onError = jest.fn();
  await speakMessage({ text: "Hello" }, onError);

  const options = native.speak.mock.calls[0][1];
  const error = new Error("synthesis failed");
  options.onError(error);
  expect(onError).toHaveBeenCalledWith(error);
});
