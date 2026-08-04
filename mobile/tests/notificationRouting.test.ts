import {
  notificationNavigationStep,
  type NotificationNavigationState,
} from "../src/lib/notificationRouting";

const emptyState = (): NotificationNavigationState => ({ lastTarget: null });

describe("notificationNavigationStep", () => {
  it("pushes the first notification over a non-notification screen", () => {
    expect(notificationNavigationStep(emptyState(), {
      type: "notification",
      pathname: "/threads",
      target: "/thread/c1/42",
    })).toEqual({ action: "push", state: { lastTarget: "/thread/c1/42" } });
  });

  it("does nothing when already viewing the target channel", () => {
    expect(notificationNavigationStep(emptyState(), {
      type: "notification",
      pathname: "/channel/c1",
      target: "/channel/c1",
    })).toEqual({ action: "none", state: { lastTarget: null } });
  });

  it("does nothing when already viewing the target thread", () => {
    const state = { lastTarget: "/thread/c1/42" };
    expect(notificationNavigationStep(state, {
      type: "notification",
      pathname: "/thread/c1/42",
      target: "/thread/c1/42",
    })).toEqual({ action: "none", state });
  });

  it("replaces a notification-opened thread when hopping to another thread", () => {
    expect(notificationNavigationStep({ lastTarget: "/thread/c1/42" }, {
      type: "notification",
      pathname: "/thread/c1/42",
      target: "/thread/c1/43",
    })).toEqual({ action: "replace", state: { lastTarget: "/thread/c1/43" } });
  });

  it("replaces a notification-opened channel when hopping to a thread", () => {
    expect(notificationNavigationStep({ lastTarget: "/channel/c1" }, {
      type: "notification",
      pathname: "/channel/c1",
      target: "/thread/c1/42",
    })).toEqual({ action: "replace", state: { lastTarget: "/thread/c1/42" } });
  });

  it("pushes over a manually reached detail screen", () => {
    expect(notificationNavigationStep({ lastTarget: "/channel/c1" }, {
      type: "notification",
      pathname: "/channel/c2",
      target: "/thread/c1/42",
    }).action).toBe("push");
  });

  it("invalidates ownership after back so manually reopening the route is preserved", () => {
    let state = emptyState();
    ({ state } = notificationNavigationStep(state, {
      type: "notification",
      pathname: "/threads",
      target: "/channel/c1",
    }));
    ({ state } = notificationNavigationStep(state, {
      type: "pathname",
      pathname: "/threads",
    }));
    ({ state } = notificationNavigationStep(state, {
      type: "pathname",
      pathname: "/channel/c1",
    }));

    expect(notificationNavigationStep(state, {
      type: "notification",
      pathname: "/channel/c1",
      target: "/thread/c1/42",
    }).action).toBe("push");
  });

  it("retains ownership across a normal notification hop", () => {
    let state = emptyState();
    ({ state } = notificationNavigationStep(state, {
      type: "notification",
      pathname: "/threads",
      target: "/channel/c1",
    }));
    ({ state } = notificationNavigationStep(state, {
      type: "pathname",
      pathname: "/channel/c1",
    }));

    expect(notificationNavigationStep(state, {
      type: "notification",
      pathname: "/channel/c1",
      target: "/thread/c1/42",
    }).action).toBe("replace");
  });
});
