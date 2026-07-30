const storybookEnabled = process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === "true";
const storybookOnly = require("./storybook-native-dependencies");

module.exports = {
  dependencies: storybookEnabled
    ? {}
    : Object.fromEntries(storybookOnly.map((name) => [
        name,
        { platforms: { android: null, ios: null } },
      ])),
};
