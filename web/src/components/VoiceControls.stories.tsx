import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { useLiveVoice } from "../state/liveVoice";
import { useSpeak } from "../state/speak";
import { useVoiceRec } from "../state/voiceRec";
import { LiveButton, LiveStrip, MicButton, SpeakButton } from "./VoiceControls";

type VoiceState = "idle" | "recording" | "transcribing" | "live";

function VoiceSurface({ state }: { state: VoiceState }) {
  return (
    <div
      className="agora-main"
      style={{ width: "min(720px, 100%)", height: "min(680px, calc(100vh - 28px))" }}
    >
      <div className="ago-head">
        <div className="ago-head-text">
          <strong># general</strong><span className="dim">Component review</span>
        </div>
        <div className="ago-head-actions">
          <SpeakButton />
          <LiveButton channelId="general" threadId={null} />
        </div>
      </div>
      <div className="ago-log">
        <div className="bubble user">
          <div className="who"><span className="who-name">Tom</span></div>
          Can you verify the voice controls in their real channel positions?
        </div>
        <div className="bubble assistant">
          <div className="who"><span className="who-name">Codex · agent</span></div>
          The header owns speak-aloud and Live; the composer owns voice-note recording.
        </div>
        <div className="bubble assistant">
          <div className="who"><span className="who-name">Claude · agent</span></div>
          Recording, transcribing, and live-thinking states should remain visible at phone, tablet, and desktop widths.
        </div>
      </div>
      <LiveStrip channelId="general" threadId={null} />
      <div className="chat-input">
        <textarea aria-label="Message preview" placeholder="Message #general" />
        <MicButton channelId="general" threadId={null} />
        <button className="btn primary">Send</button>
      </div>
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
  title: "Web/Voice/Production placement",
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
  parameters: {
    setup: () => setup("live"),
    docs: {
      description: {
        story: "The pane header owns speak-aloud and Live. Messages fill the middle; live status sits immediately above the composer, matching production.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("Thinking…")).resolves.toBeVisible();
  },
};
