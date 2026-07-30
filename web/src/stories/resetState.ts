import { useAttachmentDrafts, useLive, useTldrView } from "@agora/core";
import { useAddressing, useDrafts } from "../components/Composer";
import { useEmojiPicker } from "../components/EmojiPicker";
import { useAgentProfile, useSourcesView } from "../components/MessageItem";
import { useConfirm } from "../state/confirm";
import { useJump } from "../state/jump";
import { useUiState } from "../state/ui";

const STORAGE_KEYS = [
  "agora_sel",
  "agora_open",
  "agora_unreads_only",
  "agora_side",
  "agora_thread",
  "agoEmojiRecent",
];

/** Reset module-scoped zustand stores as well as their persisted inputs. */
export function resetStoryState(): void {
  for (const key of STORAGE_KEYS) localStorage.removeItem(key);
  useUiState.setState({
    sel: {},
    view: { kind: "channel" },
    mobileView: "side",
    panel: null,
    expanded: null,
    unreadsOnly: false,
    hiddenOpen: false,
    sideCollapsed: false,
    threadRoot: null,
    threadExpanded: false,
    membersOpen: false,
    searchOpen: false,
  });
  useConfirm.getState().disarm();
  useJump.getState().clear();
  useDrafts.setState({ drafts: {} });
  useAddressing.setState({ addr: {} });
  useAttachmentDrafts.getState().reset();
  useLive.setState({ typing: {}, progress: {} });
  useTldrView.setState({ showing: {} });
  useEmojiPicker.getState().close();
  useSourcesView.getState().close();
  useAgentProfile.getState().close();
}
