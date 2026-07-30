import type { Meta, StoryObj } from "@storybook/react-native";
import { Attachments } from "./Attachments";

const session = { baseUrl: "https://storybook.invalid", token: "storybook" };

const meta = {
  title: "Native/Messages/Attachments",
  component: Attachments,
  args: {
    session,
    attachments: [
      { id: "preview", filename: "responsive-preview.png", mime: "image/png", size: 128_000 },
      { id: "plan", filename: "storybook-component-plan.pdf", mime: "application/pdf", size: 2_842_113 },
    ],
  },
} satisfies Meta<typeof Attachments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ImageAndFile: Story = {};
export const LongAndZeroByte: Story = {
  args: {
    session,
    attachments: [
      { id: "empty", filename: "empty.txt", mime: "text/plain", size: 0 },
      {
        id: "long",
        filename: `${"native-responsive-contract-".repeat(4)}.pdf`,
        mime: "application/pdf",
        size: 9_437_184,
      },
    ],
  },
};
