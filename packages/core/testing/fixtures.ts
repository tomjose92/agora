/* Framework-free UI fixtures. Storybook and mobile Jest may both import
   these; keep Storybook decorators and browser/native APIs out of this file. */

import type {
  AgentInfo,
  ChannelAgent,
  Group,
  Me,
  Member,
  Message,
  ThreadRow,
  UserInfo,
} from "../src/api/types";

export const fixtureMarkdown = [
  "## Release readiness",
  "",
  "The responsive component catalog is **ready for review**. Run `npm run storybook -w web` and check the [interaction testing guide](https://storybook.js.org/docs/writing-tests/interaction-testing).",
  "",
  "### Review checklist",
  "",
  "- Verify the layout at phone, tablet, and desktop widths",
  "- Test keyboard navigation and visible error states",
  "- Compare shared content on web, iOS, and Android",
  "",
  "| Surface | Expected result |",
  "| --- | --- |",
  "| Web / desktop | Responsive panes without horizontal overflow |",
  "| iOS / Android | Native controls with the same fixture content |",
  "",
  "> Component stories should finish in the state a reviewer needs to inspect.",
].join("\n");

export const fixtureMe: Me = {
  username: "tom",
  display_name: "Tom",
  version: "storybook",
  instance_admin: true,
  max_file_mb: 25,
  voice: false,
  search_ai: true,
};

export const fixtureGroups: Group[] = [{
  id: "product",
  name: "Product",
  description: "Product planning and implementation",
  created_by: "tom",
  created_at: 1_750_000_000,
  role: "admin",
  is_public: false,
  channels: [
    {
      id: "general",
      group_id: "product",
      name: "storybook",
      topic: "Component development and responsive review",
      created_at: 1_750_000_000,
      unread: 4,
      mentions: 1,
      last_read_id: 40,
    },
    {
      id: "responsive",
      group_id: "product",
      name: "responsive-web",
      topic: "Web and desktop layout",
      created_at: 1_750_000_010,
      unread: 0,
      mentions: 0,
    },
  ],
}];

export const fixtureAgents: AgentInfo[] = [
  {
    id: "codex",
    name: "Codex",
    source: "bridge",
    requires_mention: false,
    last_seen: 1_750_000_200,
    live: true,
    avatar: null,
  },
  {
    id: "claude",
    name: "Claude",
    source: "bridge",
    requires_mention: true,
    last_seen: 1_750_000_180,
    live: true,
    avatar: null,
  },
];

export const fixtureChannelAgents: ChannelAgent[] = fixtureAgents.map(({ id, name }) => ({ id, name }));

export const fixtureMembers: Member[] = [
  {
    channel_id: null,
    member_type: "user",
    member_id: "tom",
    role: "admin",
    added_at: 1_750_000_000,
    name: "Tom",
  },
  {
    channel_id: null,
    member_type: "user",
    member_id: "alice",
    role: "member",
    added_at: 1_750_000_020,
    name: "Alice",
  },
  {
    channel_id: "general",
    member_type: "agent",
    member_id: "codex",
    role: "member",
    added_at: 1_750_000_030,
    name: "Codex",
  },
  {
    channel_id: "general",
    member_type: "agent",
    member_id: "claude",
    role: "member",
    added_at: 1_750_000_040,
    name: "Claude",
  },
];

export const fixtureUsers: UserInfo[] = [
  {
    username: "tom",
    display_name: "Tom",
    email: "tom@example.test",
    instance_role: "admin",
    created_at: 1_750_000_000,
    disabled: false,
  },
  {
    username: "alice",
    display_name: "Alice",
    email: "alice@example.test",
    instance_role: "member",
    created_at: 1_750_000_020,
    disabled: false,
  },
];

export const fixtureRootMessage: Message = {
  id: 42,
  channel_id: "general",
  thread_id: null,
  author_type: "user",
  author_id: "tom",
  author_name: "Tom",
  text: "Can we validate the responsive component layout?",
  ts: 1_750_000_100,
  attachments: [],
  reactions: [{ emoji: "👍", users: ["tom", "alice"] }],
  reply_count: 2,
};

export const fixtureAgentMessage: Message = {
  id: 43,
  channel_id: "general",
  thread_id: null,
  author_type: "agent",
  author_id: "codex",
  author_name: "Codex",
  text: "The real panes are now rendered over deterministic fixture data.",
  ts: 1_750_000_120,
  attachments: [],
  reactions: [
    { emoji: "👍", users: ["tom", "alice", "Codex"], reactors: [
      { type: "user", id: "tom", name: "Tom" },
      { type: "user", id: "alice", name: "Alice" },
      { type: "agent", id: "codex", name: "Codex" },
    ] },
    { emoji: "🎉", users: ["alice"], reactors: [{ type: "user", id: "alice", name: "Alice" }] },
  ],
  meta: {
    tldr: "Real panes now use deterministic fixtures.",
    unfurls: [{
      url: "https://storybook.js.org/",
      site: "storybook.js.org",
      title: "Storybook",
      description: "Build and test components in isolation.",
    }],
  },
};

export const fixtureReplies: Message[] = [
  {
    id: 44,
    channel_id: "general",
    thread_id: 42,
    author_type: "agent",
    author_id: "codex",
    author_name: "Codex",
    text: "The 820px phone boundary is covered.",
    ts: 1_750_000_140,
    attachments: [],
  },
  {
    id: 45,
    channel_id: "general",
    thread_id: 42,
    author_type: "user",
    author_id: "alice",
    author_name: "Alice",
    text: "And 821px exercises the overlay layout.",
    ts: 1_750_000_160,
    attachments: [],
  },
];

export const fixtureMessages: Message[] = [fixtureRootMessage, fixtureAgentMessage];

export const fixtureThreads: ThreadRow[] = [{
  root: fixtureRootMessage,
  channel_id: "general",
  channel_name: "storybook",
  group_id: "product",
  group_name: "Product",
  reply_count: fixtureReplies.length,
  last_reply_id: fixtureReplies.at(-1)!.id,
  last_reply_ts: fixtureReplies.at(-1)!.ts,
  last_read_id: fixtureReplies[0].id,
  unread: 1,
}];
