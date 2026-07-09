// expo-notifications' config plugin is auto-applied by prebuild (SDK 54+) and
// adds the aps-environment entitlement, which free Personal Teams cannot sign.
// We only use local notifications, so strip the push entitlement.
const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withNoPushEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    delete c.modResults["aps-environment"];
    return c;
  });
};
