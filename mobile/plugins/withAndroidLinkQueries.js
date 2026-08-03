const { withAndroidManifest } = require("@expo/config-plugins");

const schemes = ["geo", "google.navigation", "vnd.youtube"];

module.exports = function withAndroidLinkQueries(config) {
  return withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    const queries = manifest.queries ?? [];
    const existing = new Set(
      queries.flatMap((query) =>
        (query.intent ?? []).flatMap((intent) =>
          (intent.data ?? []).map((data) => data.$?.["android:scheme"]),
        ),
      ),
    );
    for (const scheme of schemes) {
      if (existing.has(scheme)) continue;
      queries.push({
        intent: [{
          action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
          data: [{ $: { "android:scheme": scheme } }],
        }],
      });
    }
    manifest.queries = queries;
    return result;
  });
};
