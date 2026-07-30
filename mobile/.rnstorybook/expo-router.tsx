import React, { useEffect, type ReactNode } from "react";
import { Text } from "react-native";

export const router = {
  push: () => {},
  replace: () => {},
  back: () => {},
};

export function useLocalSearchParams<T>(): T {
  return ((globalThis as typeof globalThis & {
    __AGORA_STORY_PARAMS__?: Record<string, string>;
  }).__AGORA_STORY_PARAMS__ ?? {
    id: "general",
    name: "storybook",
    groupId: "product",
  }) as T;
}

export function useFocusEffect(effect: () => void | (() => void)): void {
  useEffect(effect, [effect]);
}

function Screen(_props: { options?: unknown }): ReactNode {
  return null;
}

export const Stack = Object.assign(
  function StackRoot({ children }: { children?: ReactNode }) {
    return children ?? null;
  },
  { Screen },
);

export function Link({ children }: { children?: ReactNode }) {
  return <Text>{children}</Text>;
}
