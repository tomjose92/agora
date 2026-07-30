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
        { id: "owner", kind: "input", label: "Owner", placeholder: "Name" },
        { id: "approved", kind: "checkbox", label: "Approved" },
      ],
      buttons: [{ id: "submit", label: "Submit", style: "primary" }],
    },
    form_state: { owner: "Alice", approved: false },
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The form's .lbl label carries no htmlFor, so target the input directly.
    const owner = canvas.getByPlaceholderText("Name");
    await userEvent.clear(owner);
    await userEvent.type(owner, "Tom{Enter}");
    await expect(saveField).toHaveBeenCalledWith({
      field_id: "owner",
      value: "Tom",
    });
    await userEvent.click(canvas.getByRole("button", { name: "Approved" }));
    await expect(saveField).toHaveBeenCalledWith({
      field_id: "approved",
      value: true,
    });
  },
};

export const Submitted: Story = {
  args: {
    message: {
      ...formMessage,
      meta: {
        ...formMessage.meta,
        form_submitted: {
          button_id: "submit",
          by: "tom",
          ts: 1_750_000_200,
          values: { owner: "Tom", approved: true },
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Button label and attribution render in separate spans (.what / .dim).
    await expect(canvas.findByText("Submit")).resolves.toBeVisible();
    await expect(canvas.findByText(/by tom/)).resolves.toBeVisible();
    expect(canvas.queryByRole("button")).not.toBeInTheDocument();
  },
};
