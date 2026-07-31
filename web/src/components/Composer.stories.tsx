import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Composer } from "./Composer";
import { me, message } from "../stories/fixtures/data";
import { useAttachmentDrafts } from "@agora/core";

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

const previewSvg = new File([
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">'
  + '<rect width="480" height="320" fill="#312e81"/>'
  + '<circle cx="150" cy="145" r="70" fill="#8b7cff"/>'
  + '<text x="250" y="175" fill="white" font-size="28">Composer preview</text>'
  + "</svg>",
], "release-dashboard.svg", { type: "image/svg+xml" });

function stage(files: File[], status: "ready" | "preparing" = "ready") {
  useAttachmentDrafts.getState().stage("c:general", files, status, 5);
}

export const ImageAndDocuments: Story = {
  parameters: {
    setup: () => stage([
      previewSvg,
      new File(["%PDF"], "release-plan.pdf", { type: "application/pdf" }),
      new File(["review"], `${"responsive-attachment-review-".repeat(3)}.docx`, {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ]),
  },
};

export const ImagePreview: Story = {
  parameters: { setup: () => stage([previewSvg]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Preview release-dashboard.svg" }));
    const body = within(document.body);
    await expect(body.findByRole("dialog", {
      name: "Image preview: release-dashboard.svg",
    })).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(body.queryByRole("dialog", {
      name: "Image preview: release-dashboard.svg",
    })).not.toBeInTheDocument();
  },
};

export const PreparingAndFailed: Story = {
  parameters: {
    setup: () => {
      stage([new File(["pending"], "dragged-screenshot.png", { type: "image/png" })], "preparing");
      const failed = useAttachmentDrafts.getState().stage(
        "c:general",
        [new File(["broken"], "unreadable.pdf", { type: "application/pdf" })],
        "preparing",
        5,
      ).accepted[0];
      useAttachmentDrafts.getState().fail("c:general", failed.id, "Could not read unreadable.pdf");
    },
  },
};

export const SendingImage: Story = {
  parameters: {
    setup: () => {
      const [entry] = useAttachmentDrafts.getState().stage(
        "c:general",
        [previewSvg],
        "ready",
        5,
      ).accepted;
      useAttachmentDrafts.getState().beginSend("c:general", [entry.id], () => {});
    },
  },
};

export const PreviewClosesAfterSend: Story = {
  parameters: { setup: () => stage([previewSvg]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Preview release-dashboard.svg" }));
    const body = within(document.body);
    await expect(body.findByRole("dialog", {
      name: "Image preview: release-dashboard.svg",
    })).resolves.toBeVisible();

    const [entry] = useAttachmentDrafts.getState().byDraft["c:general"];
    useAttachmentDrafts.getState().beginSend("c:general", [entry.id], () => {});
    useAttachmentDrafts.getState().sendSucceeded("c:general", [entry.id]);

    await expect(body.queryByRole("dialog", {
      name: "Image preview: release-dashboard.svg",
    })).not.toBeInTheDocument();
  },
};

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
