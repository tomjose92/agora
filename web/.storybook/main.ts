import type { StorybookConfig } from "@storybook/react-vite";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const packageRoot = (name: string) => dirname(require.resolve(`${name}/package.json`));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  staticDirs: [{ from: "./static", to: "/" }],
  addons: [packageRoot("@storybook/addon-a11y"), packageRoot("@storybook/addon-vitest")],
  framework: {
    name: packageRoot("@storybook/react-vite"),
    options: {},
  },
};

export default config;
