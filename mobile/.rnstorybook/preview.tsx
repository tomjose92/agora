import React from "react";
import { View } from "react-native";
import type { Preview } from "@storybook/react-native";
import { colors } from "../src/lib/theme";

const preview: Preview = {
  decorators: [
    (Story) => (
      <View style={{ flex: 1, padding: 16, justifyContent: "center", backgroundColor: colors.bg }}>
        <Story />
      </View>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    options: {
      storySort: {
        order: ["Native", ["Foundations", "Atoms", "Messages", "Composer", "Overlays", "Screens"]],
      },
    },
  },
};

export default preview;
