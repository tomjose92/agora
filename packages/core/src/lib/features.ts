/* UI-only feature visibility. Keep disabled features wired through the API and
   state layers so their data remains current and they can be restored without
   a migration. */
export const FEATURES = {
  stars: false,
  dms: true,
};
