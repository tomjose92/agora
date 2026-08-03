import type { Meta, StoryObj } from "@storybook/react-native";
import { LiveVoiceView } from "./LiveVoice";

const meta = {
  title: "Native/Screens/Live voice",
  component: LiveVoiceView,
  args: {
    channelLabel: "general",
    threadSession: false,
    status: "listening",
    muted: false,
    muteBusy: false,
    meteringDb: -60,
    onInterrupt: () => {},
    onToggleMute: () => {},
    onEnd: () => {},
  },
} satisfies Meta<typeof LiveVoiceView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mic permission prompt still pending; mute is disabled until it resolves. */
export const Starting: Story = { args: { status: "starting" } };

export const Listening: Story = {};

/** VAD has opened a turn — the orb goes red and swells with mic level. */
export const Recording: Story = { args: { status: "recording", meteringDb: -12 } };

/** Turn uploaded; waiting for an agent reply. */
export const Thinking: Story = { args: { status: "thinking" } };

/** Agent reply playing back — tapping anywhere interrupts. */
export const Speaking: Story = { args: { status: "speaking" } };

/** Muted while idle: mic off, red-outlined Unmute control. */
export const Muted: Story = { args: { muted: true } };

/** Muting mid-reply keeps playback going and annotates the status line. */
export const MutedWhileSpeaking: Story = { args: { muted: true, status: "speaking" } };

/** A mute/unmute transition in flight — the control locks against re-taps. */
export const MuteBusy: Story = { args: { muteBusy: true } };

/** Recording permission denied. */
export const MicError: Story = { args: { status: "error" } };

/** Opened from a thread: turns post as replies under the quoted root. */
export const ThreadSession: Story = {
  args: {
    threadSession: true,
    rootSnippet: "Can we ship the video attachments release this week once the version bump lands?",
  },
};
