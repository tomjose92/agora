import type { StorybookConfig } from "@storybook/react-vite";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = (name: string) => dirname(require.resolve(`${name}/package.json`));
const configDir = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  staticDirs: [{ from: "./static", to: "/" }],
  addons: [packageRoot("@storybook/addon-a11y"), packageRoot("@storybook/addon-vitest")],
  framework: {
    name: packageRoot("@storybook/react-vite"),
    options: {},
  },
  viteFinal: async (viteConfig) => ({
    ...viteConfig,
    resolve: {
      ...viteConfig.resolve,
      // Story fixtures live beside the static Storybook build, not under
      // Agora's authenticated production /api/files route.
      alias: [
        { find: "../lib/files", replacement: resolve(configDir, "files.ts") },
      ],
    },
  }),
};

export default config;
