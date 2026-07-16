/* App Store version check: dotted-version comparison + iTunes Lookup call.
   Pure fetch/logic (no native modules) so it stays unit-testable in Jest;
   the screen supplies the installed version from expo-application. */

/** Numeric dotted-segment compare: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface StoreListing {
  version: string;
  url: string;
}

/** Latest published App Store version, or null when the app has no listing
    yet (pre-publish). Throws on network / HTTP failure. */
export async function lookupStoreVersion(bundleId: string): Promise<StoreListing | null> {
  const res = await fetch(
    `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`,
  );
  if (!res.ok) throw new Error(`App Store lookup failed (HTTP ${res.status})`);
  const json = await res.json();
  const app = json?.results?.[0];
  if (!app?.version) return null;
  return { version: app.version, url: app.trackViewUrl ?? "" };
}
