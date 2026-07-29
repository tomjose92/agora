import { deepLinkPath, type DeepLinkTarget } from "@agora/core";
import { toast } from "./toast";

export async function copyDeepLink(target: DeepLinkTarget, label: string): Promise<void> {
  const url = new URL(deepLinkPath(target), window.location.origin).toString();
  try {
    await navigator.clipboard.writeText(url);
    toast(`${label} link copied`);
  } catch {
    toast("Couldn't copy link", { variant: "warn" });
  }
}
