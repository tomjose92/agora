/* Host-agnostic API context. The host app (web, later mobile) constructs an
   ApiClient from wherever it keeps its session (localStorage, secure store)
   and provides it here; hooks in queries.ts reach it via useApi(). */

import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "./client";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("useApi called outside <ApiProvider>");
  return client;
}
