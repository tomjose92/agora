/* Metro config for consuming @agora/core (a file:../packages/core symlink).
   Three things the Expo default doesn't cover:
   - watch the package source so edits there hot-reload here;
   - resolve through the symlink's real path (which lives outside the
     project root);
   - pin the singleton libraries to mobile's copies: the repo root has its
     own node_modules (for packages/core + web), and resolution walking up
     from the package's real path would otherwise find a SECOND React there
     — the classic dual-renderer hazard. */

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.resolve(repoRoot, "packages/core")];

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

config.resolver.extraNodeModules = {
  react: path.resolve(projectRoot, "node_modules/react"),
  "react-native": path.resolve(projectRoot, "node_modules/react-native"),
  "@tanstack/react-query": path.resolve(projectRoot, "node_modules/@tanstack/react-query"),
  zustand: path.resolve(projectRoot, "node_modules/zustand"),
};

module.exports = config;
