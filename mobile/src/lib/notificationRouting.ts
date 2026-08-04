/* Notification navigation only dedupes the screen already on top. Different
   targets deliberately push so replacing a screen never destroys its draft. */

export type NotificationNavigationAction = "none" | "push";

export function notificationNavigationAction({
  pathname,
  target,
}: {
  pathname: string;
  target: string;
}): NotificationNavigationAction {
  return target === pathname ? "none" : "push";
}
