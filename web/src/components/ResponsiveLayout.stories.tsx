import type { Meta, StoryObj } from "@storybook/react-vite";

function ResponsiveLayoutProof() {
  return (
    <div id="content">
      <div className="agora-layout view-main">
        <aside className="agora-side">
          <div className="side-title">Rooms</div>
          <div className="ago-groups">
            <div className="ago-group sel">
              <div className="ago-group-head">Product</div>
              <div className="ago-chan active"><span className="hash">#</span><span className="nm">storybook</span></div>
              <div className="ago-chan"><span className="hash">#</span><span className="nm">responsive-web</span></div>
            </div>
          </div>
        </aside>
        <section className="agora-main">
          <div className="ago-head"><strong>#storybook</strong><span className="ago-head-actions">Web/Desktop</span></div>
          <div className="ago-log">
            <div className="bubble ago-bubble assistant">Resize this story across the named viewports.</div>
          </div>
        </section>
        <aside className="agora-thread">
          <div className="ago-head"><strong>Thread</strong></div>
          <div className="ago-log"><div className="bubble ago-bubble peer">Tablet overlay proof</div></div>
        </aside>
      </div>
    </div>
  );
}

const meta = {
  title: "Web/Layouts/Responsive panes",
  component: ResponsiveLayoutProof,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ResponsiveLayoutProof>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  parameters: { viewport: { defaultViewport: "desktop" } },
};

export const TabletOverlay: Story = {
  parameters: { viewport: { defaultViewport: "tablet" } },
};

export const PhoneMainPane: Story = {
  parameters: { viewport: { defaultViewport: "phone" } },
};
