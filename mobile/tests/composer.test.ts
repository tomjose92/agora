import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Composer } from "../src/components/Composer";

jest.mock("expo-audio", () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn() },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: () => ({
    prepareToRecordAsync: jest.fn(),
    record: jest.fn(),
    stop: jest.fn(),
  }),
  useAudioRecorderState: () => ({ durationMillis: 0 }),
}));
jest.mock("lucide-react-native", () => new Proxy({}, {
  get: () => function MockIcon() { return null; },
}));

const files = [
  { uri: "file:///image.png", name: "image.png", type: "image/png", size: 1_024 },
  { uri: "file:///middle.pdf", name: "middle.pdf", type: "application/pdf", size: 2_048 },
  { uri: "file:///last.txt", name: "last.txt", type: "text/plain" },
];

function labelled(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find((node) => node.props.accessibilityLabel === label);
}

test("composer attachment cards preview images and remove the selected file", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(
      SafeAreaProvider,
      {
        initialMetrics: {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      },
      React.createElement(Composer, {
        placeholder: "Message #test",
        mentions: [],
        sending: false,
        initialFiles: files,
        onSend: async () => {},
      }),
    ));
  });

  labelled(tree.root, "Preview image.png");
  labelled(tree.root, "Remove image.png");
  labelled(tree.root, "Remove middle.pdf");
  labelled(tree.root, "Remove last.txt");
  expect(tree.root.findAllByProps({ children: "1.0 KB" }).length).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ children: "2.0 KB" }).length).toBeGreaterThan(0);

  act(() => labelled(tree.root, "Remove middle.pdf").props.onPress());

  labelled(tree.root, "Remove image.png");
  labelled(tree.root, "Remove last.txt");
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Remove middle.pdf"))
    .toHaveLength(0);
  act(() => tree.unmount());
});
