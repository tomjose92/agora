import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Meta, StoryObj } from "@storybook/react-native";
import {
  fixtureAgentMessage,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import type { Message } from "@agora/core";
import { SectionRail } from "./SectionRail";
import { colors } from "../lib/theme";

const turns: Message[] = Array.from({ length: 40 }, (_, index) => ({
  ...(index % 2 === 0 ? fixtureRootMessage : fixtureAgentMessage),
  id: 100 + index,
  author_type: index % 2 === 0 ? "user" : "agent",
  text:
    index % 2 === 0 ? `Question ${index / 2 + 1}` : `Answer ${(index + 1) / 2}`,
}));

function Surface({ messages = turns }: { messages?: Message[] }) {
  const [active, setActive] = useState(messages[0]?.id ?? null);
  return (
    <View style={styles.surface}>
      <Text style={styles.copy}>
        The rail overlays the far-right edge without narrowing this message
        area.
      </Text>
      <Text style={styles.copy}>Selected message: {active ?? "none"}</Text>
      <SectionRail
        messages={messages}
        activeMessageId={active}
        onJump={setActive}
      />
    </View>
  );
}

const meta = {
  title: "Native/Navigation/Section rail",
  component: Surface,
  decorators: [
    (Story) => (
      <View style={styles.frame}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleSections: Story = {
  render: () => <Surface messages={turns.slice(0, 8)} />,
};
export const SingleSectionHidden: Story = {
  render: () => (
    <Surface messages={[fixtureRootMessage, fixtureAgentMessage]} />
  ),
};
export const WindowedOverflow: Story = { render: () => <Surface /> };
export const ThreadWithUserTurns: Story = {
  render: () => (
    <Surface
      messages={[
        { ...fixtureRootMessage, id: 200, text: "Thread root question" },
        { ...fixtureAgentMessage, id: 201, thread_id: 200, text: "First reply" },
        { ...fixtureAgentMessage, id: 202, thread_id: 200, text: "Second reply" },
        { ...fixtureRootMessage, id: 203, thread_id: 200, text: "User follow-up" },
        { ...fixtureAgentMessage, id: 204, thread_id: 200, text: "Follow-up answer" },
      ]}
    />
  ),
};

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.bg },
  surface: { flex: 1, padding: 20, backgroundColor: colors.bg },
  copy: { color: colors.text, marginBottom: 16, paddingRight: 10 },
});
