import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureChannelAgents, fixtureGroups, fixtureMembers } from "@agora/core/testing/fixtures";
import ThreadScreen from "../../app/(app)/thread/[channelId]/[rootId]";

const root = {
  id: 43, channel_id: "general", thread_id: null, author_type: "user" as const,
  author_id: "tom", author_name: "Tom", text: "Kicking off the release checklist for 0.2",
  ts: 1720000000, meta: null, reply_count: 1, alias: "Release checklist",
};
const reply = {
  id: 44, channel_id: "general", thread_id: 43, author_type: "user" as const,
  author_id: "tom", author_name: "Tom", text: "First reply",
  ts: 1720000100, meta: null, reply_count: 0, alias: null,
};

const routes = {
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/channels/general/messages?limit=50": { messages: [root] },
  "GET /api/channels/general/messages?limit=50&thread_id=43": { messages: [reply] },
  "GET /api/channels/general/agents": { agents: fixtureChannelAgents },
  "GET /api/channels/general/stars": { stars: [] },
  "GET /api/channels/general/activity": { typing: [], progress: [] },
  "GET /api/groups/product/members": { members: fixtureMembers },
  "GET /api/threads?limit=100": { threads: [] },
  "PUT /api/threads/43/read": { ok: true, last_read_id: 44 },
};

const meta = {
  title: "Native/Screens/Thread",
  component: ThreadScreen,
  parameters: {
    apiRoutes: routes,
    setup: () => {
      (globalThis as typeof globalThis & {
        __AGORA_STORY_PARAMS__?: Record<string, string>;
      }).__AGORA_STORY_PARAMS__ = { channelId: "general", rootId: "43", channelName: "agora" };
    },
  },
} satisfies Meta<typeof ThreadScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/* Renamed thread: the alias renders as a small subtitle under `Thread · # agora`. */
export const RenamedThread: Story = {};

/* Unnamed thread: no subtitle line renders under the header. */
export const UnnamedThread: Story = {
  parameters: {
    apiRoutes: {
      ...routes,
      "GET /api/channels/general/messages?limit=50": { messages: [{ ...root, alias: null }] },
      "GET /api/channels/general/messages?limit=50&thread_id=43": { messages: [reply] },
    },
  },
};
