jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///test/",
  readAsStringAsync: jest.fn(async () => {
    throw new Error("missing");
  }),
  writeAsStringAsync: jest.fn(async () => undefined),
}));

import * as FileSystem from "expo-file-system/legacy";
import { usePrefs } from "../src/state/prefs";

beforeEach(() => {
  usePrefs.setState({
    loaded: true,
    collapsedGroups: {},
    unreadsOnly: false,
    speakAloud: false,
    recentEmoji: [],
  });
  jest.clearAllMocks();
});

it("expands only the requested collapsed group and persists the change", () => {
  usePrefs.setState({ collapsedGroups: { alpha: true, beta: true } });

  usePrefs.getState().expandGroup("alpha");

  expect(usePrefs.getState().collapsedGroups).toEqual({ beta: true });
  expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
    "file:///test/ui-prefs.json",
    expect.stringContaining('"collapsedGroups":["beta"]'),
  );
});

it("does not persist when the group is already expanded", () => {
  usePrefs.getState().expandGroup("alpha");
  expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
});
