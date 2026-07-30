import React, { useEffect, type ReactNode } from "react";

export const router = {
  push: () => {},
  replace: () => {},
  back: () => {},
};

export function useLocalSearchParams<T>(): T {
  return {
    id: "general",
    name: "storybook",
    groupId: "product",
  } as T;
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
