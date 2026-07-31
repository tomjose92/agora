import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Composer } from "../src/components/Composer";
import { Attachments } from "../src/components/Attachments";

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
  { uri: "file:///image.heic", name: "image.heic", type: "image/heic", size: 1_024 },
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

  expect(labelled(tree.root, "Preview image.heic")).toBeDefined();
  expect(labelled(tree.root, "Remove image.heic")).toBeDefined();
  expect(labelled(tree.root, "Remove middle.pdf")).toBeDefined();
  expect(labelled(tree.root, "Remove last.txt")).toBeDefined();
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Preview middle.pdf"))
    .toHaveLength(0);
  expect(tree.root.findAllByProps({ children: "1.0 KB" }).length).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ children: "2.0 KB" }).length).toBeGreaterThan(0);

  act(() => labelled(tree.root, "Preview image.heic").props.onPress());
  expect(labelled(tree.root, "Close image preview")).toBeDefined();
  act(() => labelled(tree.root, "Close image preview").props.onPress());
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Close image preview"))
    .toHaveLength(0);

  act(() => labelled(tree.root, "Remove middle.pdf").props.onPress());

  expect(labelled(tree.root, "Remove image.heic")).toBeDefined();
  expect(labelled(tree.root, "Remove last.txt")).toBeDefined();
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Remove middle.pdf"))
    .toHaveLength(0);
  act(() => tree.unmount());
});

test("sent image attachments open and close the full-screen preview", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(Attachments, {
      session: { baseUrl: "https://example.invalid", token: "test" },
      attachments: [{
        id: "image",
        filename: "agent-diagram.svg",
        mime: "image/svg+xml",
        size: 4_096,
      }],
      imageSource: () => ({ uri: "data:image/svg+xml,<svg/>" }),
    }));
  });

  expect(labelled(tree.root, "Preview agent-diagram.svg")).toBeDefined();
  act(() => labelled(tree.root, "Preview agent-diagram.svg").props.onPress());
  expect(labelled(tree.root, "Close image preview")).toBeDefined();
  act(() => labelled(tree.root, "Close image preview").props.onPress());
  expect(tree.root.findAll((node) => node.props.accessibilityLabel === "Close image preview"))
    .toHaveLength(0);
  act(() => tree.unmount());
});
