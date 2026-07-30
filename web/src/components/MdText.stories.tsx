import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtureMarkdown } from "@agora/core/testing/fixtures";
import { MdText } from "./MdText";

const meta = {
  title: "Web/Atoms/Markdown",
  component: MdText,
  args: { mentions: {} },
  // MdText always renders inside a .bubble in production — the bubble carries
  // the word-break/max-width rules long content depends on.
  decorators: [(Story) => (
    <div className="ago-log" style={{ width: "min(760px, 100%)" }}>
      <div className="bubble assistant ago-bubble"><Story /></div>
    </div>
  )],
} satisfies Meta<typeof MdText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichContent: Story = {
  args: { text: fixtureMarkdown },
  parameters: {
    docs: { description: { story: "A realistic release note exercising headings, emphasis, inline code, a link, a checklist, a table, and a quote." } },
  },
};

export const LongUnbrokenContent: Story = {
  args: {
    text: [
      "A copied build-artifact URL must wrap without widening the message pane:",
      "",
      "https://downloads.example.test/agora/builds/2026-07-30/desktop/apple-silicon/agora-component-catalog-release-candidate-with-a-deliberately-long-unbroken-checksum-7f94c38be229b91f61755ba4c7e92626d5f0d9a8b671c95d4f79a34c2e8a1d60.zip",
    ].join("\n"),
  },
  parameters: {
    docs: { description: { story: "A realistic long, unbroken artifact URL proving links wrap instead of forcing horizontal scrolling." } },
  },
};
