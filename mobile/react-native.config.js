const storybookEnabled = process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === "true";

const storybookOnly = [
  "@react-native-async-storage/async-storage",
  "@react-native-community/datetimepicker",
  "@react-native-community/slider",
  "react-native-gesture-handler",
  "react-native-reanimated",
  "react-native-worklets",
];

module.exports = {
  dependencies: storybookEnabled
    ? {}
    : Object.fromEntries(storybookOnly.map((name) => [
        name,
        { platforms: { android: null, ios: null } },
      ])),
};
