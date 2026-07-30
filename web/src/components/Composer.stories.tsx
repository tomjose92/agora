import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Composer } from "./Composer";
import { me, message } from "../stories/fixtures/data";

const agents = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
];

const candidates = [
  { type: "agent" as const, id: "codex", name: "Codex", slug: "codex" },
  { type: "agent" as const, id: "claude", name: "Claude", slug: "claude" },
  { type: "user" as const, id: "alice", name: "Alice", slug: "alice" },
];

const sendMessage = fn((body: unknown) => ({
  ...message,
  text: (body as { text: string }).text,
}));

const meta = {
  title: "Web/Composer/Message composer",
  component: Composer,
  decorators: [(Story) => (
    <div
      className="agora-main"
      style={{ width: "min(760px, 100%)", minHeight: 320, justifyContent: "flex-end" }}
    >
      <Story />
    </div>
  )],
  args: {
    channelId: "general",
    channelName: "general",
    threadId: null,
    agents,
    candidates,
    voiceOK: false,
    replyInThread: false,
    onSetReplyInThread: fn(),
  },
  parameters: {
    apiRoutes: {
      "GET /api/me": me,
      "GET /api/agents": { agents },
      "POST /api/channels/general/messages": sendMessage,
    },
  },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const DraftWithMention: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Message #general");
    await userEvent.type(input, "Could @co");
    await expect(canvas.findByText("Codex")).resolves.toBeVisible();
  },
};

export const SendAddressedMessage: Story = {
  play: async ({ canvasElement }) => {
    sendMessage.mockClear();
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTitle("Choose which agents you're talking to"));
    await userEvent.click(await canvas.findByText("Codex"));
    const input = await canvas.findByPlaceholderText("Message #general");
    await userEvent.type(input, "Please review");
    await userEvent.keyboard("{Enter}");
    await expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: "@codex, Please review",
      thread_id: null,
    }));
    await expect(input).toHaveValue("");
  },
};

export const AddressingPicker: Story = {
  parameters: {
    docs: { description: { story: "Opens the upward “Talk to” menu used to address one or more agents before composing a channel message." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTitle("Choose which agents you're talking to"));
    await expect(canvas.findByText("Talk to")).resolves.toBeVisible();
    await expect(canvas.findByText("Claude")).resolves.toBeVisible();
  },
};

export const ThreadReply: Story = {
  args: {
    threadId: 42,
    onSetReplyInThread: undefined,
  },
  parameters: {
    docs: {
      description: {
        story: "The composer inside an existing thread. It keeps a thread-scoped draft and omits the channel-level “reply in thread” toggle.",
      },
    },
  },
};
