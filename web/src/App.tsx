/* Root: session → ApiProvider → authed layout (topbar + agora panes).
   The auth gate shows when there is no token or /api/me rejects it, exactly
   like the vanilla boot() path. */

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiClient, ApiProvider, useMe } from "@agora/core";
import { sessionToken, clearJoinToken } from "./lib/auth";
import { AuthGate } from "./components/AuthGate";
import { Topbar } from "./components/Topbar";
import { AgoraLayout } from "./components/AgoraLayout";
import { ToastHost } from "./lib/toast";

function AuthedApp({ onAuthFailed }: { onAuthFailed: () => void }) {
  const me = useMe();
  const failed = me.isError || (!me.isLoading && !me.data);
  useEffect(() => {
    if (failed) onAuthFailed();
    else if (me.data) clearJoinToken();
  }, [failed, me.data, onAuthFailed]);
  if (me.isLoading || failed) return null;
  return (
    <>
      <main>
        <Topbar />
        <AgoraLayout />
      </main>
      <ToastHost />
    </>
  );
}

export function App() {
  const [token, setToken] = useState(sessionToken());
  const [gateVisible, setGateVisible] = useState(!token);
  const qc = useQueryClient();

  const client = useMemo(
    () => new ApiClient({ baseUrl: "", token }),
    [token],
  );

  const signedIn = () => {
    qc.clear();
    setToken(sessionToken());
    setGateVisible(false);
  };

  if (gateVisible || !token) {
    return (
      <>
        <AuthGate onSignedIn={signedIn} />
        <ToastHost />
      </>
    );
  }
  return (
    <ApiProvider client={client}>
      <AuthedApp onAuthFailed={() => setGateVisible(true)} />
    </ApiProvider>
  );
}
