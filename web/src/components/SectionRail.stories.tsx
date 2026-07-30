import { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  fixtureAgentMessage,
  fixtureAgents,
  fixtureMe,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import { SectionRail } from "./SectionRail";
import { MessageItem } from "./MessageItem";

const messages = [
  fixtureRootMessage,
  fixtureAgentMessage,
  { ...fixtureRootMessage, id: 46, author_id: "alice", author_name: "Alice", text: "How does the tablet thread overlay behave?" },
  { ...fixtureAgentMessage, id: 47, text: "It now uses an opaque surface, so the channel below never bleeds through." },
  { ...fixtureRootMessage, id: 48, text: "Can we verify keyboard navigation before merging?" },
  { ...fixtureAgentMessage, id: 49, text: "Yes. Click any dot to jump between these three conversational sections." },
];

function RailSurface() {
  const boxRef = useRef<HTMLDivElement>(null);
  return (
    <div
      className="ago-log-wrap"
      style={{
        width: "min(720px, 100%)",
        height: "min(520px, calc(100vh - 40px))",
        flex: "0 0 auto",
        overflow: "hidden",
      }}
    >
      <div ref={boxRef} className="ago-log" style={{ height: "100%", minHeight: 0 }}>
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            inThread={false}
            isAdmin
            mentions={{}}
            onOpenThread={fn()}
          />
        ))}
        <SectionRail boxRef={boxRef} messages={messages} />
      </div>
    </div>
  );
}

const meta = {
  title: "Web/Navigation/Section rail",
  component: RailSurface,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/agents": { agents: fixtureAgents },
      "GET /api/channels/general/pins": { pins: [] },
      "GET /api/channels/general/stars": { stars: [] },
    },
    docs: {
      description: {
        story: "Three realistic user/agent sections. Hover or focus the right-edge dots, then click one to jump to that topic.",
      },
    },
  },
} satisfies Meta<typeof RailSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleSections: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const navigation = await canvas.findByRole("navigation", {
      name: "Jump to a section of the conversation",
    });
    const dots = within(navigation).getAllByRole("button");
    expect(dots).toHaveLength(3);
    const log = canvasElement.querySelector<HTMLElement>(".ago-log");
    if (!log) throw new Error("Missing scrollable message log");
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight);
    // The dots smooth-scroll; wait for the animation to settle before
    // capturing a reference position, or the second click races it.
    const settled = async () => {
      let last = -1;
      await waitFor(() => {
        const now = log.scrollTop;
        const stable = now === last && now > 0;
        last = now;
        expect(stable).toBe(true);
      }, { interval: 120, timeout: 5000 });
      return log.scrollTop;
    };
    await userEvent.click(dots[2]);
    const lowerPosition = await settled();
    await userEvent.click(dots[0]);
    await waitFor(() => expect(log.scrollTop).toBeLessThan(lowerPosition));
  },
};
