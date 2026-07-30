import type { Meta, StoryObj } from "@storybook/react-vite";
import { Attachments } from "./Attachments";
import { message } from "../stories/fixtures/data";

const meta = {
  title: "Web/Atoms/Attachments",
  component: Attachments,
} satisfies Meta<typeof Attachments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Files: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        { id: "requirements", filename: "storybook-requirements.pdf", mime: "application/pdf", size: 428_032 },
        { id: "archive", filename: "component-fixtures.zip", mime: "application/zip", size: 2_842_113 },
      ],
    },
  },
};
