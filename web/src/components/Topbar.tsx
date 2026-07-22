/* Topbar: brand, server badge, connection-status dot, self-rename button,
   and the operator-only People/Connections buttons. Same ids/classes as
   ui/index.html + shim.js renderServerBadge()/boot(). */

import { useEffect } from "react";
import { useMe, useApi } from "@agora/core";
import { toast } from "../lib/toast";
import { useUiState } from "../state/ui";

function ServerBadge() {
  const host = location.hostname;
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
  useEffect(() => {
    document.title = local ? "Agora — Local" : "Agora — " + host;
  }, [local, host]);
  return local ? (
    <div className="server-badge" id="server-badge"
      title="This Agora runs on this computer — messages and data are stored here.">
      <span className="srv-dot local"></span>Local server
    </div>
  ) : (
    <div className="server-badge" id="server-badge"
      title={`Connected to ${location.origin} — messages and data live on that server.`}>
      <span className="srv-dot remote"></span>Remote · <b>{host}</b>
    </div>
  );
}

export function Topbar() {
  const api = useApi();
  const me = useMe().data;
  const openPanel = useUiState(s => s.openPanel);
  const isAdmin = !!me?.instance_admin;

  const rename = async () => {
    const next = window.prompt(
      "Display name (leave blank to use your username):",
      me?.display_name || me?.username || "");
    if (next === null) return;
    try {
      await api.patch("/api/me", { display_name: next.trim() });
      toast("Display name updated", { variant: "ok" });
    } catch (e) {
      toast("Couldn't update your name: " + ((e as Error).message || e), { variant: "error" });
    }
  };

  return (
    <div className="topbar">
      <div className="brand"><span className="brand-mark"><img src="/icon.png" alt="" /></span> Agora</div>
      <ServerBadge />
      <div className="topbar-status" id="topbar-status"></div>
      <button className="topbar-me" id="topbar-me" title="Change how your name appears"
        onClick={() => void rename()}>
        {me ? (me.display_name || me.username) : ""}
      </button>
      {isAdmin && (
        <button className="btn sm" id="btn-people" onClick={() => openPanel("people")}>People</button>
      )}
      {isAdmin && (
        <button className="btn sm" id="btn-connections" onClick={() => openPanel("connections")}>Connections</button>
      )}
    </div>
  );
}
