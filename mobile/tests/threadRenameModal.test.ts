import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet, TextInput } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, type ThreadRow } from "@agora/core";
import { RenameModal } from "../app/(app)/threads";
import { colors } from "../src/lib/theme";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

const thread = {
  root: { id: 42, alias: "Launch notes", text: "Original thread message" },
} as ThreadRow;

it("renders the rename dialog on an opaque accessible modal surface", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const api = new ApiClient({ baseUrl: "https://agora.example", token: "test" });
  const onClose = jest.fn();
  let tree!: TestRenderer.ReactTestRenderer;

  act(() => {
    tree = TestRenderer.create(React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        ApiProvider,
        { client: api },
        React.createElement(RenameModal, { thread, onClose }),
      ),
    ));
  });

  const dialog = tree.root.findByProps({ testID: "rename-thread-dialog" });
  const backgroundColor = StyleSheet.flatten(dialog.props.style).backgroundColor;
  expect(dialog.props.accessibilityViewIsModal).toBe(true);
  expect(dialog.props.accessibilityLabel).toBe("Rename thread dialog");
  expect(backgroundColor).toBe(colors.sheet);
  expect(backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
  expect(tree.root.findByType(TextInput).props.value).toBe("Launch notes");

  const backdrop = tree.root.find((node) => node.props.onPress === onClose);
  act(() => backdrop.props.onPress());
  expect(onClose).toHaveBeenCalledTimes(1);

  act(() => tree.unmount());
  queryClient.clear();
});
