import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { fixtureTemplates } from "@agora/core/testing/fixtures";
import { TemplateSheet } from "./TemplateSheet";

const route = "GET /api/groups/product/templates";

const meta = {
  title: "Native/Composer/Template sheet",
  component: TemplateSheet,
  args: {
    groupId: "product",
    visible: true,
    draft: "",
    onChoose: fn(),
    onClose: fn(),
  },
  parameters: {
    apiRoutes: { [route]: { templates: fixtureTemplates } },
  },
} satisfies Meta<typeof TemplateSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  parameters: { apiRoutes: { [route]: { templates: [] } } },
};

/* The editor prefills from the draft, so this is also the "save what I just
   typed" entry point — tap "Add template" to see it. */
export const WithDraftToSave: Story = {
  args: { draft: "Shipping the templates PR now — review when you get a chance." },
};

export const LoadFailed: Story = {
  parameters: {
    apiRoutes: {
      [route]: () => {
        throw new Error("offline");
      },
    },
  },
};
