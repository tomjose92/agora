import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Attachments } from "./Attachments";
import { message } from "../stories/fixtures/data";

const meta = {
  title: "Web/Atoms/Attachments",
  component: Attachments,
} satisfies Meta<typeof Attachments>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Files: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        { id: "requirements", filename: "storybook-requirements.pdf", mime: "application/pdf", size: 428_032 },
        { id: "archive", filename: "component-fixtures.zip", mime: "application/zip", size: 2_842_113 },
      ],
    },
  },
};

export const ImageLightbox: Story = {
  args: {
    message: {
      ...message,
      attachments: [{
        id: "storybook-preview.svg",
        filename: "responsive-layout-preview.svg",
        mime: "image/svg+xml",
        size: 1_024,
      }],
    },
  },
  parameters: {
    docs: { description: { story: "Clicking an inline image opens the full-screen preview. Escape and backdrop clicks close it; this story finishes with the preview open for inspection." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", {
      name: "Preview responsive-layout-preview.svg",
    }));
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.findByRole("dialog", {
      name: "Image preview: responsive-layout-preview.svg",
    })).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole("button", {
      name: "Preview responsive-layout-preview.svg",
    }));
    await expect(page.findByRole("dialog", {
      name: "Image preview: responsive-layout-preview.svg",
    })).resolves.toBeVisible();
  },
};

export const LongAndZeroByteFiles: Story = {
  args: {
    message: {
      ...message,
      attachments: [
        {
          id: "empty",
          filename: "empty.txt",
          mime: "text/plain",
          size: 0,
        },
        {
          id: "long",
          filename: `${"responsive-component-contract-".repeat(4)}.pdf`,
          mime: "application/pdf",
          size: 9_437_184,
        },
      ],
    },
  },
  globals: { viewport: { value: "smallPhone", isRotated: false } },
  parameters: {
    docs: { description: { story: "Exercises the edge cases for a zero-byte file (`0 B`) and truncation of a very long filename on a 320px-wide phone." } },
  },
};
