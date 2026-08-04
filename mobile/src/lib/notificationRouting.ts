/* Notification navigation only dedupes the screen already on top. Different
   targets deliberately push so replacing a screen never destroys its draft.
   Same-target taps stay inert even when the viewer is scrolled above the
   newest message; scrolling is owned by the destination screen, not here. */

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
