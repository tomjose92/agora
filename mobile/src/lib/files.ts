/** Image formats that Expo Image, browsers, and the server vision paths share. */
export const WEB_SAFE_IMAGE = /^image\/(jpe?g|png|gif|webp)$/i;

/** Formats Expo Image can display after an attachment has reached the server. */
export const BROWSER_IMAGE = /^image\/(jpeg|png|gif|webp|svg\+xml|bmp)$/i;
