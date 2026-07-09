/* Keyboard helpers for the chat screens. expo-router 57 vendors
   react-navigation and no longer exposes useHeaderHeight, so the
   KeyboardAvoidingView offset is derived the same way the navigator does:
   status bar inset + the 44pt native-stack nav bar (iOS only — Android
   resizes the window itself). */

import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const IOS_NAV_BAR_HEIGHT = 44;

/** Offset for a KeyboardAvoidingView sitting under a native-stack header. */
export function useHeaderKeyboardOffset(): number {
  const insets = useSafeAreaInsets();
  return Platform.OS === "ios" ? insets.top + IOS_NAV_BAR_HEIGHT : 0;
}

/** Whether the software keyboard is (about to be) on screen. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, () => setVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
