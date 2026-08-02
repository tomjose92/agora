jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock("../src/lib/nativeSpeech", () => ({ speakMessage: jest.fn(async () => {}) }));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text, TextInput } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ApiClient, ApiProvider, type Message } from "@agora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessageActions } from "../src/components/MessageActions";
import { useSession } from "../src/state/session";

class RecordingApi extends ApiClient {
  patches: Array<{ path: string; body: unknown }> = [];
  constructor() { super({ baseUrl: "https://agora.example", token: "test" }); }
  override async patch<T>(path: string, body?: unknown): Promise<T> {
    this.patches.push({ path, body });
    return { ...message, text: (body as { text: string }).text, meta: { edited_at: 123 } } as T;
  }
}

const message: Message = {
  id: 7, channel_id: "general", thread_id: null, author_type: "user",
  author_id: "alice", author_name: "Alice",
  text: "First block\n\nSecond block\n\n| A | B |\n|---|---|\n| 1 | 2 |",
  ts: 1, attachments: [],
};

function render(overrides: Partial<React.ComponentProps<typeof MessageActions>> = {}) {
  const api = new RecordingApi();
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(QueryClientProvider, { client: new QueryClient() },
        React.createElement(ApiProvider, { client: api },
          React.createElement(MessageActions, {
            message, channelId: "general", starred: false, canEdit: true,
            canPin: true, canDelete: false, onClose: jest.fn(), onReact: jest.fn(), ...overrides,
          }),
        ),
      ),
    );
  });
  return { tree, api };
}

function pressLabel(tree: TestRenderer.ReactTestRenderer, text: string) {
  let node: TestRenderer.ReactTestInstance | null =
    tree.root.findAllByType(Text).find((n) => n.props.children === text) ?? null;
  while (node && typeof node.props.onPress !== "function") node = node.parent;
  if (!node) throw new Error(`No press target for ${text}`);
  return node.props.onPress();
}

beforeAll(() => useSession.setState({ username: "alice" }));

test("Copy writes the entire raw multi-block message", async () => {
  const { tree } = render();
  await act(async () => { pressLabel(tree, "Copy"); await Promise.resolve(); });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(message.text);
  act(() => tree.unmount());
});

test("Edit is author-gated and saves raw multiline text", async () => {
  const { tree, api } = render();
  await act(async () => { pressLabel(tree, "Edit"); await Promise.resolve(); });
  const input = tree.root.findByType(TextInput);
  act(() => input.props.onChangeText("Changed\n\nwith blocks"));
  await act(async () => { pressLabel(tree, "Save"); await Promise.resolve(); });
  expect(api.patches).toEqual([{
    path: "/api/channels/general/messages/7",
    body: { text: "Changed\n\nwith blocks" },
  }]);

  const hidden = render({ canEdit: false }).tree;
  expect(hidden.root.findAllByType(Text).some((n) => n.props.children === "Edit")).toBe(false);
  act(() => { tree.unmount(); hidden.unmount(); });
});
