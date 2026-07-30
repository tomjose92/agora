import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  fixtureAgentMessage,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import { SectionRail } from "./SectionRail";

const scrollTo = fn();
const messages = [
  fixtureRootMessage,
  fixtureAgentMessage,
  { ...fixtureRootMessage, id: 46, author_id: "alice", author_name: "Alice", text: "Second topic" },
  { ...fixtureAgentMessage, id: 47, text: "A reply in the second section" },
];

function RailSurface() {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTo = scrollTo;
  }, []);
  return (
    <div ref={boxRef} style={{ height: 260, overflow: "auto", position: "relative" }}>
      {messages.map((message) => (
        <div key={message.id} data-mid={message.id} style={{ minHeight: 160 }}>
          {message.author_name}: {message.text}
        </div>
      ))}
      <SectionRail boxRef={boxRef} messages={messages} />
    </div>
  );
}

const meta = {
  title: "Web/Navigation/Section rail",
  component: RailSurface,
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
    expect(dots).toHaveLength(2);
    await userEvent.click(dots[1]);
    await expect(scrollTo).toHaveBeenCalled();
  },
};
