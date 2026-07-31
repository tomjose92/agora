import type React from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { ScrollView } from "react-native";
import { AddAgentFlow, AgentConnectionsList } from "./AgentConnections";

const routes = {
  "GET /api/connections": {
    connections: [
      {
        name: "Home Pantheo",
        url: "wss://pantheo.example/agora/connect",
        enabled: true,
        status: {
          name: "Home Pantheo",
          url: "wss://pantheo.example/agora/connect",
          connected: true,
          agents: [{ id: "research", name: "Research" }],
          last_error: null,
        },
      },
      {
        name: "Office Pantheo",
        url: "wss://offline.example/agora/connect",
        enabled: true,
        status: {
          name: "Office Pantheo",
          url: "wss://offline.example/agora/connect",
          connected: false,
          agents: [],
          last_error: "Connection refused",
        },
      },
    ],
  },
  "GET /api/pairing": {
    tokens: [
      {
        token: "codex_example_token_1234",
        name: "Codex laptop",
        kind: "codex",
        created_at: 1,
        connected: true,
        agents: [{ id: "codex", name: "Codex" }],
      },
      {
        token: "custom_example_token_5678",
        name: "Custom integration",
        created_at: 2,
        connected: false,
        agents: [],
      },
    ],
  },
  "POST /api/pairing": { token: "agora_pairing_example_please_keep_secret" },
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView contentContainerStyle={{ paddingVertical: 12 }}>
      {children}
    </ScrollView>
  );
}

const meta = {
  title: "Native/Screens/Agent connections",
  component: AddAgentFlow,
  parameters: { apiRoutes: routes },
} satisfies Meta<typeof AddAgentFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Catalog: Story = {
  render: () => (
    <Frame>
      <AddAgentFlow />
    </Frame>
  ),
};
export const CodingAgents: Story = {
  render: () => (
    <Frame>
      <AddAgentFlow initialKind="coding" />
    </Frame>
  ),
};
export const Success: Story = {
  render: () => (
    <Frame>
      <AddAgentFlow
        initialKind="codex"
        initialIssued="agora_pairing_example_please_keep_secret"
      />
    </Frame>
  ),
};
export const RemoteSuccess: Story = {
  render: () => (
    <Frame>
      <AddAgentFlow
        initialKind="hermes"
        initialIssued="agora_pairing_example_please_keep_secret"
      />
    </Frame>
  ),
};
export const Connections: Story = {
  render: () => (
    <Frame>
      <AgentConnectionsList />
    </Frame>
  ),
};
