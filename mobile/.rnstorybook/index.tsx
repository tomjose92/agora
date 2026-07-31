import AsyncStorage from "@react-native-async-storage/async-storage";
import { registerRootComponent } from "expo";
import { view } from "./storybook.requires";

const StorybookUIRoot = view.getStorybookUI({
  onDeviceUI: true,
  shouldPersistSelection: true,
  storage: {
    getItem: AsyncStorage.getItem,
    setItem: AsyncStorage.setItem,
  },
});

/* Storybook's withStorybook() swaps the app entry (index.js) for THIS file,
   so index.js's registerRootComponent never runs in storybook mode —
   the entry has to register itself. Registering here is harmless if this
   module is instead imported from index.js (same component, same key). */
registerRootComponent(StorybookUIRoot);

export default StorybookUIRoot;
