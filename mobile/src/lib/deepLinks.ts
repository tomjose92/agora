import * as Clipboard from "expo-clipboard";
import { deepLinkPath, type DeepLinkTarget } from "@agora/core";
import { useSession } from "../state/session";
import { toast } from "../components/Toast";

/** Copy an absolute Agora link for `target`, resolved against the signed-in instance. */
export async function copyDeepLink(target: DeepLinkTarget, label: string): Promise<void> {
  const origin = useSession.getState().session?.baseUrl;
  if (!origin) {
    toast("Couldn't copy link", "warn");
    return;
  }
  try {
    await Clipboard.setStringAsync(new URL(deepLinkPath(target), origin).toString());
    toast(`${label} link copied`);
  } catch {
    toast("Couldn't copy link", "warn");
  }
}
