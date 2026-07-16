// Strip entitlements that free Personal Teams cannot sign, so local dev
// builds (`expo run:ios` on a personal team) keep working:
// - aps-environment: added by expo-notifications' auto-applied plugin; we
//   only use local notifications until a paid account enables APNs.
// - com.apple.developer.applesignin: added by expo-apple-authentication;
//   the connect screen hides the Apple button when the capability is absent
//   (isAvailableAsync -> false), so stripping it degrades cleanly.
// Drop this plugin from app.json once the paid Developer account is set up
// (Phase 2 of the publishing plan) to enable both capabilities.
const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withNoPushEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults["aps-environment"];
    delete c.modResults["com.apple.developer.applesignin"];
    return c;
  });
};
