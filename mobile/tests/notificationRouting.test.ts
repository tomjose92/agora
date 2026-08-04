import { notificationNavigationAction } from "../src/lib/notificationRouting";

describe("notificationNavigationAction", () => {
  it("pushes the first notification over a non-notification screen", () => {
    expect(notificationNavigationAction({
      pathname: "/threads",
      lastNotificationTarget: null,
      target: "/thread/c1/42",
    })).toBe("push");
  });

  it("does nothing when already viewing the target channel", () => {
    expect(notificationNavigationAction({
      pathname: "/channel/c1",
      lastNotificationTarget: null,
      target: "/channel/c1",
    })).toBe("none");
  });

  it("does nothing when already viewing the target thread", () => {
    expect(notificationNavigationAction({
      pathname: "/thread/c1/42",
      lastNotificationTarget: "/thread/c1/42",
      target: "/thread/c1/42",
    })).toBe("none");
  });

  it("replaces a notification-opened thread when hopping to another thread", () => {
    expect(notificationNavigationAction({
      pathname: "/thread/c1/42",
      lastNotificationTarget: "/thread/c1/42",
      target: "/thread/c1/43",
    })).toBe("replace");
  });

  it("replaces a notification-opened channel when hopping to a thread", () => {
    expect(notificationNavigationAction({
      pathname: "/channel/c1",
      lastNotificationTarget: "/channel/c1",
      target: "/thread/c1/42",
    })).toBe("replace");
  });

  it("pushes over a manually reached detail screen", () => {
    expect(notificationNavigationAction({
      pathname: "/channel/c2",
      lastNotificationTarget: "/channel/c1",
      target: "/thread/c1/42",
    })).toBe("push");
  });
});
