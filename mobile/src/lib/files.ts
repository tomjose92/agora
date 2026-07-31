/* Image formats browsers and the server vision paths accept. Other formats
   picked as photos are re-encoded to JPEG before upload. */
export const WEB_SAFE_IMAGE = /^image\/(jpe?g|png|gif|webp)$/i;

/** Formats Expo Image can display natively after an attachment reaches the server. */
export const NATIVE_IMAGE = /^image\/(jpe?g|png|gif|webp|svg\+xml|bmp|hei[cf]|avif)$/i;
