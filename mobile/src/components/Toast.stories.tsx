import type { Meta, StoryObj } from "@storybook/react-native";
import { useToasts, ToastHost } from "./Toast";

const meta = {
  title: "Native/Overlays/Toast",
  component: ToastHost,
  parameters: {
    setup: () => useToasts.setState({
      items: [
        { id: 1, message: "Message sent successfully" },
        { id: 2, message: "Missing fixture route is visible on device", variant: "warn" },
      ],
    }),
  },
} satisfies Meta<typeof ToastHost>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SuccessAndWarning: Story = {};
