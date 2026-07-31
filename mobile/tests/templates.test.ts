/* Message templates: the composer's picker sheet and caret insertion. */

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, MAX_MESSAGE_CHARS } from "@agora/core";
import { fixtureTemplates } from "@agora/core/testing/fixtures";
import { Composer } from "../src/components/Composer";
import { useToasts } from "../src/components/Toast";

jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///cache/",
  EncodingType: { Base64: "base64" },
  copyAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
  getInfoAsync: jest.fn(async () => ({ exists: true, size: 4_096 })),
  writeAsStringAsync: jest.fn(async () => {}),
}));
jest.mock("expo-paste-input", () => {
  const mockReact = require("react");
  const { View: MockView } = require("react-native");
  return {
    TextInputWrapper: ({ children, ...props }: React.PropsWithChildren<object>) =>
      mockReact.createElement(MockView, { ...props, testID: "paste-aware-input" }, children),
  };
});
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

function labelled(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find((node) => node.props.accessibilityLabel === label);
}

class TemplateApi extends ApiClient {
  constructor() {
    super({ baseUrl: "https://example.invalid", token: "test" });
  }

  override async get<T>(path: string): Promise<T> {
    if (path === "/api/groups/product/templates") return { templates: fixtureTemplates } as T;
    throw new Error(`Unexpected GET ${path}`);
  }
}

test("a chosen template lands at the caret without replacing the draft", async () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      // gcTime 0 so nothing is scheduled past the end of the test.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        ApiProvider,
        { client: new TemplateApi() },
        React.createElement(SafeAreaProvider, {
          initialMetrics: {
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
          },
        }, React.createElement(Composer, {
          placeholder: "Message #test",
          mentions: [],
          groupId: "product",
          sending: false,
          onSend: async () => {},
        })),
      ),
    ));
    await new Promise((resolve) => setImmediate(resolve));
  });

  /* `placeholder` is also a Composer prop, so match the TextInput itself. */
  const input = () => tree.root.findAll((node) =>
    node.props.placeholder === "Message #test" && typeof node.props.onFocus === "function")[0];
  // Focus reveals the toolbar the templates button lives in, then type a draft
  // and leave the caret mid-text.
  act(() => input().props.onFocus());
  act(() => input().props.onChangeText("Hi  — thanks"));
  act(() => input().props.onSelectionChange({ nativeEvent: { selection: { start: 3, end: 3 } } }));

  await act(async () => {
    labelled(tree.root, "Message templates").props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });

  const [first] = fixtureTemplates;
  await act(async () => {
    labelled(tree.root, `Use template ${first.label}`).props.onPress();
    // Insertion refocuses the input from a rAF callback; let it run.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(input().props.value).toBe(`Hi ${first.text} — thanks`);
  // The caret is controlled for exactly one selection change, so programmatic
  // placement never fights the next keystroke.
  expect(input().props.selection).toEqual({
    start: 3 + first.text.length,
    end: 3 + first.text.length,
  });
  act(() => input().props.onSelectionChange({
    nativeEvent: { selection: { start: 3 + first.text.length, end: 3 + first.text.length } },
  }));
  expect(input().props.selection).toBeUndefined();

  const full = "x".repeat(MAX_MESSAGE_CHARS);
  act(() => input().props.onChangeText(full));
  act(() => input().props.onSelectionChange({
    nativeEvent: { selection: { start: full.length, end: full.length } },
  }));
  await act(async () => {
    labelled(tree.root, "Message templates").props.onPress();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await act(async () => {
    labelled(tree.root, `Use template ${first.label}`).props.onPress();
  });
  expect(input().props.value).toBe(full);
  expect(useToasts.getState().items.at(-1)?.message).toContain("would exceed");
  useToasts.setState({ items: [] });
  act(() => tree.unmount());
  // Drop the cache so no background refetch outlives the test environment.
  queryClient.clear();
});
