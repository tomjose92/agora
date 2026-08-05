import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { StyleSheet } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, keys, type Group } from "@agora/core";
import { DmGroupCard } from "../app/(app)/index";
import { colors } from "../src/lib/theme";

jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));
jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

const group: Group = {
  id: "__dms", name: "Direct messages", description: "Private conversations with agents",
  created_by: null, created_at: 0, role: "member", kind: "agent_dms", channels: [],
};

it("renders the agent DM picker on the opaque sheet surface", () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(keys.dms, { conversations: [], agents: [] });
  queryClient.setQueryData(keys.agents, []);
  const api = new ApiClient({ baseUrl: "https://agora.example", token: "test" });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(
      QueryClientProvider, { client: queryClient },
      React.createElement(ApiProvider, { client: api },
        React.createElement(DmGroupCard, { group, unreadsOnly: false, initialChoosing: true }),
      ),
    ));
  });
  const card = tree.root.findByProps({ testID: "agent-dm-modal-card" });
  const flattened = StyleSheet.flatten(card.props.style);
  expect(flattened.backgroundColor).toBe(colors.sheet);
  expect(flattened.backgroundColor).not.toMatch(/^rgba\(/);
  act(() => tree.unmount());
  queryClient.clear();
});
