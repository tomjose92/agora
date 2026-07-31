import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider } from "@agora/core";
import {
  AddAgentFlow,
  AgentConnectionsList,
} from "../src/components/AgentConnections";
import { useSession } from "../src/state/session";
import AddAgentScreen from "../app/(app)/add-agent";

jest.mock(
  "lucide-react-native",
  () =>
    new Proxy(
      {},
      {
        get: () =>
          function MockIcon() {
            return null;
          },
      },
    ),
);
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
}));

class RecordingApi extends ApiClient {
  calls: Array<{ path: string; body: unknown }> = [];

  constructor() {
    super({ baseUrl: "https://agora.example", token: "test" });
  }

  override async post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body });
    return { token: "issued-secret-token" } as T;
  }

  override async get<T>(path: string): Promise<T> {
    if (path === "/api/connections") {
      return {
        connections: [
          {
            name: "Disabled Pantheo",
            url: "wss://pantheo.example/agora/connect",
            enabled: false,
            status: null,
          },
        ],
      } as T;
    }
    if (path === "/api/pairing") {
      return {
        tokens: [
          {
            token: "codex-token",
            name: "Codex laptop",
            kind: "codex",
            created_at: 1,
          },
          {
            token: "custom-token",
            name: "Custom integration",
            created_at: 2,
          },
        ],
      } as T;
    }
    throw new Error(`Unexpected GET ${path}`);
  }
}

function renderFlow(
  api: RecordingApi,
  element = React.createElement(AddAgentFlow),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ApiProvider, { client: api }, element),
      ),
    );
  });
  return tree;
}

function labelled(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find((node) => node.props.accessibilityLabel === label);
}

function pressText(root: TestRenderer.ReactTestInstance, text: string) {
  const label = root.findByProps({ children: text });
  let current = label;
  while (current.parent && typeof current.props.onPress !== "function") {
    current = current.parent;
  }
  current.props.onPress();
}

beforeEach(() => {
  useSession.setState({
    status: "signedIn",
    session: { baseUrl: "https://agora.example/path", token: "test" },
    username: "admin",
    displayName: "Admin",
    instanceAdmin: true,
  });
});

test("catalog creates typed Codex access and renders the issued credential", async () => {
  const api = new RecordingApi();
  const tree = renderFlow(api);

  act(() => labelled(tree.root, "Connect a coding agent").props.onPress());
  act(() => labelled(tree.root, "Connect Codex CLI").props.onPress());
  const input = tree.root.findByProps({ placeholder: "Codex" });
  act(() => input.props.onChangeText("Work Codex"));
  await act(async () => pressText(tree.root, "Create access"));

  expect(api.calls).toEqual([
    {
      path: "/api/pairing",
      body: { name: "Work Codex", kind: "codex" },
    },
  ]);
  expect(JSON.stringify(tree.toJSON())).toContain("issued-secret-token");
  act(() => tree.unmount());
});

test("Another agent deliberately creates generic access without kind", async () => {
  const api = new RecordingApi();
  const tree = renderFlow(api);

  act(() =>
    labelled(tree.root, "Create access for another agent").props.onPress(),
  );
  const input = tree.root.findByProps({ placeholder: "Agent" });
  act(() => input.props.onChangeText("Future connector"));
  await act(async () => pressText(tree.root, "Create access"));

  expect(api.calls[0]).toEqual({
    path: "/api/pairing",
    body: { name: "Future connector", kind: undefined },
  });
  act(() => tree.unmount());
});

test("success state shows the supplied token and remote socket address", () => {
  const tree = renderFlow(
    new RecordingApi(),
    React.createElement(AddAgentFlow, {
      initialKind: "hermes",
      initialIssued: "one-time-token",
    }),
  );
  expect(JSON.stringify(tree.toJSON())).toContain("one-time-token");
  expect(JSON.stringify(tree.toJSON())).toContain(
    "wss://agora.example/agent/ws?token=one-time-token",
  );
  act(() => tree.unmount());
});

test("connection list distinguishes disabled links and unknown agent kinds", async () => {
  const tree = renderFlow(
    new RecordingApi(),
    React.createElement(AgentConnectionsList),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const rendered = JSON.stringify(tree.toJSON());

  expect(rendered).toContain("Disabled Pantheo");
  expect(rendered).toContain("Disabled");
  expect(rendered).not.toContain("Connecting…");
  expect(rendered).toContain("Codex");
  expect(rendered).toContain("Agent");
  act(() => tree.unmount());
});

test("non-admins see the route denial instead of the management flow", () => {
  act(() => useSession.setState({ instanceAdmin: false }));
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(AddAgentScreen));
  });
  expect(JSON.stringify(tree.toJSON())).toContain("Admin access required");
  expect(JSON.stringify(tree.toJSON())).not.toContain("Add agent");
  act(() => tree.unmount());
});
