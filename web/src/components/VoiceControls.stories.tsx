import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { useLiveVoice } from "../state/liveVoice";
import { useSpeak } from "../state/speak";
import { useVoiceRec } from "../state/voiceRec";
import { LiveButton, LiveStrip, MicButton, SpeakButton } from "./VoiceControls";

type VoiceState = "idle" | "recording" | "transcribing" | "live";

function VoiceSurface({ state }: { state: VoiceState }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <MicButton channelId="general" threadId={null} />
      <SpeakButton />
      <LiveButton channelId="general" threadId={null} />
      <LiveStrip channelId="general" threadId={null} />
      <span hidden>{state}</span>
    </div>
  );
}

function setup(state: VoiceState) {
  useVoiceRec.setState({
    recordingKey: state === "recording" ? "c:general" : null,
    startedAt: Date.now() - 12_000,
    busyKey: state === "transcribing" ? "c:general" : null,
  });
  useLiveVoice.setState({
    scope: state === "live" ? { channelId: "general", threadId: null } : null,
    state: state === "live" ? "thinking" : "listening",
  });
  useSpeak.setState({ on: state === "live" });
}

const meta = {
  title: "Web/Voice/Controls",
  component: VoiceSurface,
  args: { state: "idle" },
  parameters: { setup: () => setup("idle") },
} satisfies Meta<typeof VoiceSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};
export const Recording: Story = {
  args: { state: "recording" },
  parameters: { setup: () => setup("recording") },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByTitle("Stop and send")).resolves.toBeVisible();
  },
};
export const Transcribing: Story = {
  args: { state: "transcribing" },
  parameters: { setup: () => setup("transcribing") },
};
export const LiveThinking: Story = {
  args: { state: "live" },
  parameters: { setup: () => setup("live") },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("Thinking…")).resolves.toBeVisible();
  },
};
