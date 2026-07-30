import React, { useState, type ReactNode } from "react";
import { View } from "react-native";
import type { Preview } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiProvider } from "@agora/core";
import {
  fixtureAgents,
  fixtureMe,
  fixtureUsers,
} from "@agora/core/testing/fixtures";
import { colors } from "../src/lib/theme";
import {
  FixtureApiClient,
  type FixtureRoutes,
} from "../src/storybook/FixtureApiClient";
import { useSession } from "../src/state/session";

const session = { baseUrl: "https://storybook.invalid", token: "storybook" };
const defaultRoutes: FixtureRoutes = {
  "GET /api/me": fixtureMe,
  "GET /api/agents": { agents: fixtureAgents },
  "GET /api/users": { users: fixtureUsers },
};

function Providers({ routes, children }: { routes?: FixtureRoutes; children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  }));
  const [api] = useState(() => new FixtureApiClient({ ...defaultRoutes, ...routes }));
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={api}>{children}</ApiProvider>
    </QueryClientProvider>
  );
}

const preview: Preview = {
  beforeEach: () => {
    useSession.setState({
      status: "signedIn",
      session,
      username: fixtureMe.username,
      displayName: fixtureMe.display_name,
      instanceAdmin: fixtureMe.instance_admin,
      voiceOk: fixtureMe.voice,
      savedUrl: session.baseUrl,
    });
  },
  decorators: [
    (Story, context) => (
      <Providers key={context.id} routes={context.parameters.apiRoutes as FixtureRoutes | undefined}>
        <View style={{ flex: 1, padding: 16, justifyContent: "center", backgroundColor: colors.bg }}>
          <Story />
        </View>
      </Providers>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    options: {
      storySort: {
        order: ["Native", ["Foundations", "Atoms", "Messages", "Composer", "Overlays", "Screens"]],
      },
    },
  },
};

export default preview;
