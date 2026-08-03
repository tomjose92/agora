import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { LinkPreferences } from "./LinkPreferences";
import type { LinkBrowser } from "../state/prefs";

function Demo({ initialBrowser = "in-app", initialNative = true, chromeAvailable = true }: {
  initialBrowser?: LinkBrowser;
  initialNative?: boolean;
  chromeAvailable?: boolean;
}) {
  const [browser, setBrowser] = useState(initialBrowser);
  const [native, setNative] = useState(initialNative);
  return <LinkPreferences preferNativeApps={native} browser={browser} onPreferNativeAppsChange={setNative} onBrowserChange={setBrowser} chromeAvailable={chromeAvailable} />;
}

const meta = { title: "Native/Screens/Link preferences", component: LinkPreferences } satisfies Meta<typeof LinkPreferences>;
export default meta;
type Story = StoryObj<typeof meta>;

const args = {
  preferNativeApps: true,
  browser: "in-app" as const,
  onPreferNativeAppsChange: () => {},
  onBrowserChange: () => {},
};

export const InApp: Story = { args, render: () => <Demo /> };
export const SystemWithoutNativeApps: Story = { args, render: () => <Demo initialBrowser="system" initialNative={false} /> };
export const ChromeInstalled: Story = { args, render: () => <Demo initialBrowser="chrome" /> };
export const ChromeUnavailable: Story = { args, render: () => <Demo chromeAvailable={false} /> };
