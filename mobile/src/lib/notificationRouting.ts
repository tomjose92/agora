export type NotificationNavigationAction = "none" | "push" | "replace";

export interface NotificationNavigationState {
  lastTarget: string | null;
}

export type NotificationNavigationEvent =
  | { type: "pathname"; pathname: string }
  | { type: "notification"; pathname: string; target: string };

/** Keep notification hops out of history without erasing routes the user
    reached through normal in-app navigation. */
export function notificationNavigationStep(
  state: NotificationNavigationState,
  event: NotificationNavigationEvent,
): { state: NotificationNavigationState; action: NotificationNavigationAction } {
  if (event.type === "pathname") {
    const lastTarget = state.lastTarget === event.pathname ? state.lastTarget : null;
    return { state: { lastTarget }, action: "none" };
  }

  if (event.target === event.pathname) {
    // Deliberately don't claim a manually opened screen as notification-owned.
    return { state, action: "none" };
  }
  return {
    state: { lastTarget: event.target },
    action: state.lastTarget === event.pathname ? "replace" : "push",
  };
}
