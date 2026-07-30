import type { Meta, StoryObj } from "@storybook/react-native";
import { MermaidBlock } from "./Mermaid";

const meta = {
  title: "Native/Messages/Mermaid",
  component: MermaidBlock,
  args: {
    code: "flowchart LR\n  Story[Story] --> Review[Review]\n  Review --> Approve[Approve]",
    maxWidth: 320,
  },
} satisfies Meta<typeof MermaidBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DiagramPreview: Story = {};
export const InvalidSourceFallback: Story = {
  args: {
    code: "this is deliberately not valid mermaid syntax {{{",
    maxWidth: 320,
  },
};
