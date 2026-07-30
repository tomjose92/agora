import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";
import {
  fixtureAgents,
  fixtureChannelAgents,
  fixtureGroups,
  fixtureMe,
  fixtureMembers,
  fixtureMessages,
  fixtureReplies,
  fixtureThreads,
  fixtureUsers,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { Sidebar } from "./Sidebar";
import { ChannelPane } from "./ChannelPane";
import { ThreadPane } from "./ThreadPane";
import { MembersPanel } from "./MembersPanel";

type LayoutMode = "channel" | "thread" | "members";

function RealResponsivePanes({ mode }: { mode: LayoutMode }) {
  const mobileView = useUiState((state) => state.mobileView);
  const threadRoot = useUiState((state) => state.threadRoot);
  return (
    <div id="content">
      <div className={`agora-layout view-${mobileView}`}>
        <Sidebar />
        <ChannelPane />
        {threadRoot != null
          ? <ThreadPane />
          : <div className="agora-thread" id="agora-thread" style={{ display: "none" }} />}
        <MembersPanel />
      </div>
      <span hidden data-layout-mode={mode} />
    </div>
  );
}

const routes = {
  "GET /api/me": fixtureMe,
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/threads?limit=100": { threads: fixtureThreads },
  "GET /api/agents": { agents: fixtureAgents },
  "GET /api/users": { users: fixtureUsers },
  "GET /api/groups/product/members": { members: fixtureMembers },
  "GET /api/channels/general/agents": { agents: fixtureChannelAgents },
  "GET /api/channels/general/activity": { typing: [], progress: [] },
  "GET /api/channels/general/messages?limit=50": { messages: fixtureMessages },
  "GET /api/channels/general/messages?limit=50&thread_id=42": { messages: fixtureReplies },
  "GET /api/messages/42": fixtureMessages[0],
  "GET /api/channels/general/pins": { pins: [] },
  "GET /api/channels/general/stars": { stars: [] },
  "PUT /api/channels/general/read": { ok: true, last_read_id: 43 },
  "PUT /api/threads/42/read": { ok: true, last_read_id: 45 },
};

function setup(mode: LayoutMode): void {
  useUiState.setState({
    sel: { g: "product", c: "general" },
    view: { kind: "channel" },
    mobileView: mode === "thread" ? "thread" : "main",
    threadRoot: mode === "thread" ? 42 : null,
    membersOpen: mode === "members",
  });
}

function element(canvasElement: HTMLElement, selector: string): HTMLElement {
  const found = canvasElement.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing responsive pane: ${selector}`);
  return found;
}

async function expectNoHorizontalOverflow(canvasElement: HTMLElement): Promise<void> {
  await waitFor(() => {
    const doc = canvasElement.ownerDocument.documentElement;
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  });
}

const meta = {
  title: "Web/Layouts/Responsive panes",
  component: RealResponsivePanes,
  args: { mode: "channel" },
  parameters: {
    layout: "fullscreen",
    apiRoutes: routes,
    setup: () => setup("channel"),
  },
} satisfies Meta<typeof RealResponsivePanes>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  globals: { viewport: { value: "desktopBoundary", isRotated: false } },
  parameters: {
    viewport: { defaultViewport: "desktopBoundary" },
    setup: () => setup("channel"),
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(element(canvasElement, "#agora-main")).toBeVisible());
    expect(getComputedStyle(element(canvasElement, "#agora-side")).position).not.toBe("fixed");
    await expectNoHorizontalOverflow(canvasElement);
  },
};

export const PhoneMainPane: Story = {
  globals: { viewport: { value: "phoneUpperBoundary", isRotated: false } },
  parameters: {
    viewport: { defaultViewport: "phoneUpperBoundary" },
    setup: () => setup("channel"),
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(element(canvasElement, "#agora-main")).toBeVisible());
    expect(element(canvasElement, "#agora-side")).not.toBeVisible();
    expect(element(canvasElement, "#agora-thread")).not.toBeVisible();
    await expectNoHorizontalOverflow(canvasElement);
  },
};

export const TabletThreadOverlay: Story = {
  globals: { viewport: { value: "tabletLowerBoundary", isRotated: false } },
  args: { mode: "thread" },
  parameters: {
    viewport: { defaultViewport: "tabletLowerBoundary" },
    setup: () => setup("thread"),
  },
  play: async ({ canvasElement }) => {
    const thread = element(canvasElement, "#agora-thread");
    await waitFor(() => expect(thread).toBeVisible());
    expect(getComputedStyle(thread).position).toBe("fixed");
    expect(element(canvasElement, "#agora-main")).toBeVisible();
    await expectNoHorizontalOverflow(canvasElement);
  },
};

export const TabletMembersOverlay: Story = {
  globals: { viewport: { value: "tablet", isRotated: false } },
  args: { mode: "members" },
  parameters: {
    viewport: { defaultViewport: "tablet" },
    setup: () => setup("members"),
  },
  play: async ({ canvasElement }) => {
    const members = element(canvasElement, "#agora-members-pane");
    await waitFor(() => expect(members).toBeVisible());
    expect(getComputedStyle(members).position).toBe("fixed");
    expect(element(canvasElement, "#agora-main")).toBeVisible();
    await expectNoHorizontalOverflow(canvasElement);
  },
};
