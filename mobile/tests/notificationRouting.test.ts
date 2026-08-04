import { notificationNavigationAction } from "../src/lib/notificationRouting";

describe("notificationNavigationAction", () => {
  it("does nothing when already viewing the target channel", () => {
    expect(notificationNavigationAction({
      pathname: "/channel/c1",
      target: "/channel/c1",
    })).toBe("none");
  });

  it("does nothing when already viewing the target thread", () => {
    expect(notificationNavigationAction({
      pathname: "/thread/c1/42",
      target: "/thread/c1/42",
    })).toBe("none");
  });

  it("pushes a notification for a different target to preserve the current draft", () => {
    expect(notificationNavigationAction({
      pathname: "/channel/c1",
      target: "/thread/c1/42",
    })).toBe("push");
  });

  it("pushes the first notification over a non-detail screen", () => {
    expect(notificationNavigationAction({
      pathname: "/threads",
      target: "/thread/c1/42",
    })).toBe("push");
  });
});
