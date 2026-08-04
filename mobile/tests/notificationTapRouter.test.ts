/* Pin the notification hook-to-router wiring; the navigation policy itself
   stays covered separately in notificationRouting.test.ts. */

const mockPush = jest.fn();
let mockPathname = "/threads";
let mockResponse: ReturnType<typeof response> | null = null;

jest.mock(
  "lucide-react-native",
  () => new Proxy({}, { get: () => () => null }),
);

jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: () => null,
  router: { push: (...args: unknown[]) => mockPush(...args) },
  usePathname: () => mockPathname,
}));

jest.mock("expo-notifications", () => ({
  useLastNotificationResponse: () => mockResponse,
}));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { NotificationTapRouter } from "../app/(app)/_layout";

function response(id: string, channelId: string, threadId?: number) {
  return {
    notification: {
      request: {
        identifier: id,
        content: {
          data: { channel_id: channelId, thread_id: threadId },
        },
      },
    },
  };
}

function renderRouter() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(NotificationTapRouter));
  });
  return tree;
}

beforeEach(() => {
  mockPush.mockClear();
  mockPathname = "/threads";
  mockResponse = null;
});

test("does not push when the notification target is already on top", () => {
  mockPathname = "/channel/c1";
  mockResponse = response("n1", "c1");
  renderRouter();
  expect(mockPush).not.toHaveBeenCalled();
});

test("pushes exactly once for a different notification target", () => {
  mockResponse = response("n1", "c1", 42);
  renderRouter();
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith("/thread/c1/42");
});

test("does not push a repeated notification identifier after pathname changes", () => {
  mockResponse = response("n1", "c1");
  const tree = renderRouter();
  expect(mockPush).toHaveBeenCalledTimes(1);

  mockPathname = "/channel/c1";
  act(() => tree.update(React.createElement(NotificationTapRouter)));
  expect(mockPush).toHaveBeenCalledTimes(1);
});
