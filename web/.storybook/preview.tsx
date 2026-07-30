import type { Preview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiProvider } from "@agora/core";
import { FixtureApiClient } from "../src/stories/fixtures/api";
import { resetStoryState } from "../src/stories/resetState";
import "../src/styles.css";

const preview: Preview = {
  decorators: [
    (Story, context) => {
      resetStoryState(context.id);
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      });
      const api = new FixtureApiClient(context.parameters.apiRoutes);
      return (
        <QueryClientProvider client={queryClient}>
          <ApiProvider client={api}>
            <main style={{ minHeight: "100vh" }}>
              <Story />
            </main>
          </ApiProvider>
        </QueryClientProvider>
      );
    },
  ],
  parameters: {
    a11y: {
      // Informational during the initial catalog rollout.
      test: "todo",
    },
    controls: { expanded: true },
    viewport: {
      options: {
        desktop: { name: "Desktop", styles: { width: "1440px", height: "900px" } },
        desktopBoundary: { name: "Desktop boundary", styles: { width: "1101px", height: "800px" } },
        tablet: { name: "Tablet overlay", styles: { width: "1000px", height: "1180px" } },
        phone: { name: "Phone", styles: { width: "390px", height: "844px" } },
        smallPhone: { name: "Small phone", styles: { width: "320px", height: "568px" } },
      },
    },
  },
};

export default preview;
