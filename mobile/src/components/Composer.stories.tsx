import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { useAddressed } from "@agora/core";
import { Composer } from "./Composer";

const agents = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
];
const mentions = [...agents, { id: "alice", name: "Alice" }];
const send = fn(async () => {});

const meta = {
  title: "Native/Composer/Message composer",
  component: Composer,
  args: {
    placeholder: "Message #storybook",
    mentions,
    agents,
    addressKey: "general",
    sending: false,
    threadToggle: true,
    onSend: send,
  },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const ImageAndDocuments: Story = {
  args: {
    initialFiles: [
      {
        uri: "https://picsum.photos/seed/agora-composer/480/320",
        name: "release-dashboard.jpg",
        type: "image/jpeg",
        size: 128_000,
      },
      {
        uri: "file:///storybook/release-plan.pdf",
        name: "release-plan.pdf",
        type: "application/pdf",
        size: 2_842_113,
      },
      {
        uri: "file:///storybook/very-long-document.docx",
        name: `${"responsive-attachment-review-".repeat(3)}.docx`,
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 543_210,
      },
    ],
  },
};

export const AddressedToAgents: Story = {
  parameters: {
    setup: () => useAddressed.setState({ byConvo: { general: ["codex", "claude"] } }),
  },
};

export const Sending: Story = {
  args: {
    placeholder: "Message #storybook",
    mentions,
    agents,
    addressKey: "general",
    sending: true,
    threadToggle: true,
    onSend: send,
  },
};

export const ThreadReply: Story = {
  args: {
    placeholder: "Reply in thread",
    mentions,
    agents,
    addressKey: "general:t42",
    sending: false,
    threadToggle: false,
    onSend: send,
  },
};
