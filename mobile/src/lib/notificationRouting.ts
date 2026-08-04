export type NotificationNavigationAction = "none" | "push" | "replace";

/** Keep notification hops out of history without erasing routes the user
    reached through normal in-app navigation. */
export function notificationNavigationAction({
  pathname,
  lastNotificationTarget,
  target,
}: {
  pathname: string;
  lastNotificationTarget: string | null;
  target: string;
}): NotificationNavigationAction {
  if (target === pathname) return "none";
  if (lastNotificationTarget !== null && pathname === lastNotificationTarget) {
    return "replace";
  }
  return "push";
}
