import type { Meta, StoryObj } from "@storybook/react-native";
import { ProgressBubbles, TypingRow } from "./LiveRows";

function LiveActivity({ progress }: { progress: boolean }) {
  return progress
    ? <ProgressBubbles progress={[{
        type: "progress",
        channel_id: "general",
        thread_id: null,
        agent_id: "codex",
        agent_name: "Codex",
        handle: "story",
        text: "checking responsive layouts",
      }]} />
    : <TypingRow typing={[{
        type: "typing",
        channel_id: "general",
        thread_id: null,
        agent_id: "claude",
        agent_name: "Claude",
        active: true,
      }]} />;
}

const meta = {
  title: "Native/Messages/Live activity",
  component: LiveActivity,
  args: { progress: false },
} satisfies Meta<typeof LiveActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Typing: Story = {};
export const Progress: Story = { args: { progress: true } };
