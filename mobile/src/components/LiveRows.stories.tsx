import type { Meta, StoryObj } from "@storybook/react-native";
import { ProgressBubbles, TypingRow } from "./LiveRows";

function LiveActivity({ progress, multiple, long }: {
  progress: boolean;
  multiple: boolean;
  long: boolean;
}) {
  return progress
    ? <ProgressBubbles progress={[{
        type: "progress",
        channel_id: "general",
        thread_id: null,
        agent_id: "codex",
        agent_name: "Codex",
        handle: "story",
        text: long
          ? "Checking responsive layouts, fixture routes, keyboard behavior, and every component variation before approving the next phase."
          : "checking responsive layouts",
      }, ...(multiple ? [{
        type: "progress" as const,
        channel_id: "general",
        thread_id: null,
        agent_id: "claude",
        agent_name: "Claude",
        handle: "review",
        text: "reviewing component variations",
      }] : [])]} />
    : <TypingRow typing={[{
        type: "typing",
        channel_id: "general",
        thread_id: null,
        agent_id: "claude",
        agent_name: "Claude",
        active: true,
      }, ...(multiple ? [{
        type: "typing" as const,
        channel_id: "general",
        thread_id: null,
        agent_id: "codex",
        agent_name: "Codex",
        active: true,
      }] : [])]} />;
}

const meta = {
  title: "Native/Messages/Live activity",
  component: LiveActivity,
  args: { progress: false, multiple: false, long: false },
} satisfies Meta<typeof LiveActivity>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Typing: Story = {};
export const Progress: Story = { args: { progress: true } };
export const MultipleAgents: Story = { args: { progress: false, multiple: true, long: false } };
export const LongProgress: Story = { args: { progress: true, multiple: true, long: true } };
