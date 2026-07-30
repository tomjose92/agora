import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { Message } from "@agora/core";
import { MessageFormView } from "./MessageFormView";
import { message } from "../stories/fixtures/data";

const formMessage: Message = {
  ...message,
  id: 51,
  meta: {
    form: {
      fields: [
        { id: "owner", kind: "input", label: "Review owner", placeholder: "Name" },
        { id: "release", kind: "input", label: "Release candidate", placeholder: "Version or build" },
        { id: "notes", kind: "input", label: "Decision notes", placeholder: "What should the team know?" },
        { id: "responsive", kind: "checkbox", label: "Phone, tablet, and desktop reviewed" },
        { id: "accessible", kind: "checkbox", label: "Keyboard and screen-reader checks complete" },
        { id: "approved", kind: "checkbox", label: "Approved to merge" },
      ],
      buttons: [
        { id: "submit", label: "Approve release", style: "primary" },
        { id: "changes", label: "Request changes", style: "secondary" },
      ],
    },
    form_state: {
      owner: "Alice",
      release: "desktop 0.1.0 / mobile 0.1.0",
      notes: "Verify the tablet overlay before approval.",
      responsive: true,
      accessible: false,
      approved: false,
    },
  },
};

const saveField = fn(() => formMessage);
const submitForm = fn(() => formMessage);

const meta = {
  title: "Web/Messages/Interactive form",
  component: MessageFormView,
  args: { message: formMessage },
  parameters: {
    apiRoutes: {
      "POST /api/messages/51/form_state": saveField,
      "POST /api/messages/51/form_submit": submitForm,
    },
  },
} satisfies Meta<typeof MessageFormView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Editable: Story = {
  decorators: [(Story) => <div style={{ width: "min(680px, 100%)" }}><Story /></div>],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const owner = canvas.getByLabelText("Review owner");
    await userEvent.clear(owner);
    await userEvent.type(owner, "Tom{Enter}");
    await expect(saveField).toHaveBeenCalledWith({
      field_id: "owner",
      value: "Tom",
    });
    await userEvent.click(canvas.getByRole("button", { name: "Approved to merge" }));
    await expect(saveField).toHaveBeenCalledWith({
      field_id: "approved",
      value: true,
    });
  },
};

export const Submitted: Story = {
  decorators: [(Story) => <div style={{ width: "min(680px, 100%)" }}><Story /></div>],
  args: {
    message: {
      ...formMessage,
      meta: {
        ...formMessage.meta,
        form_submitted: {
          button_id: "submit",
          by: "tom",
          ts: 1_750_000_200,
          values: {
            owner: "Tom",
            release: "desktop 0.1.0 / mobile 0.1.0",
            notes: "All responsive and interaction checks passed.",
            responsive: true,
            accessible: true,
            approved: true,
          },
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Button label and attribution render in separate spans (.what / .dim).
    await expect(canvas.findByText("Approve release")).resolves.toBeVisible();
    await expect(canvas.findByText(/by tom/)).resolves.toBeVisible();
    expect(canvas.queryByRole("button")).not.toBeInTheDocument();
  },
};
