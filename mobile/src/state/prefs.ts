/* Small persisted UI prefs (group expansion, unreads-only filter) so the
   home screen looks the way you left it. Backed by a JSON file in the app's
   document dir — same pattern as the background poller's snapshot; nothing
   here is secret so the keychain would be overkill. */

import * as FileSystem from "expo-file-system/legacy";
import { create } from "zustand";

const PREFS_FILE = `${FileSystem.documentDirectory ?? ""}ui-prefs.json`;

interface PersistedPrefs {
  collapsedGroups: string[];
  unreadsOnly: boolean;
  speakAloud: boolean;
}

interface PrefsState {
  loaded: boolean;
  /** Collapsed (not expanded) set, so unseen groups default to expanded. */
  collapsedGroups: Record<string, true>;
  unreadsOnly: boolean;
  /** 🔊: agent replies in the channel you're viewing are read aloud (TTS). */
  speakAloud: boolean;
  load: () => Promise<void>;
  toggleGroup: (groupId: string) => void;
  setUnreadsOnly: (on: boolean) => void;
  setSpeakAloud: (on: boolean) => void;
}

function persist(state: PrefsState): void {
  const data: PersistedPrefs = {
    collapsedGroups: Object.keys(state.collapsedGroups),
    unreadsOnly: state.unreadsOnly,
    speakAloud: state.speakAloud,
  };
  FileSystem.writeAsStringAsync(PREFS_FILE, JSON.stringify(data)).catch(() => {
    /* best-effort */
  });
}

export const usePrefs = create<PrefsState>((set, get) => ({
  loaded: false,
  collapsedGroups: {},
  unreadsOnly: false,
  speakAloud: false,

  async load() {
    try {
      const text = await FileSystem.readAsStringAsync(PREFS_FILE);
      const data = JSON.parse(text) as Partial<PersistedPrefs>;
      set({
        loaded: true,
        collapsedGroups: Object.fromEntries(
          (data.collapsedGroups ?? []).map((id) => [id, true as const]),
        ),
        unreadsOnly: !!data.unreadsOnly,
        speakAloud: !!data.speakAloud,
      });
    } catch {
      set({ loaded: true }); // first run
    }
  },

  toggleGroup(groupId) {
    const collapsed = { ...get().collapsedGroups };
    if (collapsed[groupId]) delete collapsed[groupId];
    else collapsed[groupId] = true;
    set({ collapsedGroups: collapsed });
    persist(get());
  },

  setUnreadsOnly(on) {
    set({ unreadsOnly: on });
    persist(get());
  },

  setSpeakAloud(on) {
    set({ speakAloud: on });
    persist(get());
  },
}));
