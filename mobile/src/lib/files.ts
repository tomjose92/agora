/** Image formats that Expo Image, browsers, and the server vision paths share. */
export const WEB_SAFE_IMAGE = /^image\/(jpe?g|png|gif|webp)$/i;

/** Formats Expo Image can display natively after an attachment reaches the server. */
export const NATIVE_IMAGE = /^image\/(jpeg|png|gif|webp|svg\+xml|bmp|hei[cf]|avif)$/i;
