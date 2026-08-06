jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-clipboard", () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock("../src/lib/nativeSpeech", () => ({ speakMessage: jest.fn(async () => {}) }));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Alert, Text, TextInput } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ApiClient, ApiProvider, type Message } from "@agora/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessageActions } from "../src/components/MessageActions";
import { useSession } from "../src/state/session";

class RecordingApi extends ApiClient {
  patches: Array<{ path: string; body: unknown }> = [];
  deletes: string[] = [];
  constructor() { super({ baseUrl: "https://agora.example", token: "test" }); }
  override async patch<T>(path: string, body?: unknown): Promise<T> {
    this.patches.push({ path, body });
    return { ...message, text: (body as { text: string }).text, meta: { edited_at: 123 } } as T;
  }
  override async delete<T>(path: string): Promise<T> {
    this.deletes.push(path);
    return { ok: true } as T;
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

beforeAll(() => useSession.setState({
  username: "alice",
  session: { baseUrl: "https://agora.example", token: "test" },
}));

function labels(tree: TestRenderer.ReactTestRenderer): unknown[] {
  return tree.root.findAllByType(Text).map((node) => node.props.children);
}

test("Copy writes the entire raw multi-block message", async () => {
  const { tree } = render();
  await act(async () => { pressLabel(tree, "Copy"); await Promise.resolve(); });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(message.text);
  act(() => tree.unmount());
});

test("keeps Pin visible while Star is hidden", () => {
  const { tree } = render();
  const labels = tree.root.findAllByType(Text).map((node) => node.props.children);
  expect(labels).toContain("Pin");
  expect(labels).not.toContain("Star");
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

test("Delete keeps the sheet mounted until the alert action finishes", async () => {
  const onClose = jest.fn();
  const onDeleted = jest.fn();
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { tree, api } = render({ canDelete: true, onClose, onDeleted });

  act(() => pressLabel(tree, "Delete"));
  expect(onClose).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0][2]!;
  const confirm = buttons.find((button) => button.text === "Delete")!;
  await act(async () => { await confirm.onPress?.(); });

  expect(api.deletes).toEqual(["/api/channels/general/messages/7"]);
  expect(onDeleted).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  alert.mockRestore();
  act(() => tree.unmount());
});

test("Copy link writes an absolute message deep link", async () => {
  (Clipboard.setStringAsync as jest.Mock).mockClear();
  const { tree } = render({ groupId: "acme" });
  await act(async () => { pressLabel(tree, "Copy link"); await Promise.resolve(); });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith("https://agora.example/g/acme/c/general/m/7");
  act(() => tree.unmount());
});

test("Copy link includes the thread segment for replies", async () => {
  (Clipboard.setStringAsync as jest.Mock).mockClear();
  const { tree } = render({ groupId: "acme", message: { ...message, thread_id: 3 } });
  expect(labels(tree)).not.toContain("Copy thread link");
  await act(async () => { pressLabel(tree, "Copy link"); await Promise.resolve(); });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith("https://agora.example/g/acme/c/general/t/3/m/7");
  act(() => tree.unmount());
});

test("the link row is gated on the authoritative group", () => {
  const noGroup = render().tree;
  expect(labels(noGroup)).not.toContain("Copy link");

  const withGroup = render({ groupId: "acme" }).tree;
  expect(labels(withGroup)).toContain("Copy link");
  expect(labels(withGroup)).not.toContain("Copy thread link");
  act(() => { noGroup.unmount(); withGroup.unmount(); });
});
