/* The chat layout (.agora-layout): sidebar + main pane + thread pane +
   members pane, with the same layout-state classes the CSS keys off
   (view-*, side-collapsed, thread-expanded). Mounts the live socket and
   defaults the selection to the first visible group/channel like
   agoLoadGroups. */

import { useEffect } from "react";
import { useGroups, useMe } from "@agora/core";
import { useAgoraSocket } from "../hooks/useAgoraSocket";
import { useUiState } from "../state/ui";
import { Sidebar } from "./Sidebar";
import { ChannelPane } from "./ChannelPane";
import { ThreadsInbox } from "./ThreadsInbox";
import { ThreadPane } from "./ThreadPane";
import { GroupOverview } from "./GroupOverview";
import { MembersPanel } from "./MembersPanel";
import { SearchPane } from "./SearchPane";
import { PeoplePane } from "./PeoplePane";
import { ConnectionsPane } from "./ConnectionsPane";
import { SourcesViewer } from "./SourcesViewer";
import { AgentProfileCard } from "./AgentProfileCard";
import { EmojiPickerHost } from "./EmojiPicker";
import { useToggleReactionById } from "../hooks/useToggleReactionById";

export function AgoraLayout() {
  const me = useMe().data;
  const groups = useGroups().data;
  const ui = useUiState();
  useAgoraSocket(me?.username || "");
  const toggleReaction = useToggleReactionById();

  // Default selection once groups load (mirrors agoLoadGroups).
  useEffect(() => {
    if (!groups || !groups.length) return;
    const selGroup = groups.find(g => g.id === ui.sel.g);
    if (!selGroup) {
      const first = groups.find(g => !g.hidden) || groups[0];
      if (first) {
        const chan = (first.channels || []).find(c => !c.hidden) || (first.channels || [])[0];
        if (chan) ui.selectChannel(first.id, chan.id);
      }
      return;
    }
    const selChan = (selGroup.channels || []).find(c => c.id === ui.sel.c);
    if (!selChan && ui.view.kind === "channel") {
      const chan = (selGroup.channels || []).find(c => !c.hidden) || (selGroup.channels || [])[0];
      if (chan) ui.selectChannel(selGroup.id, chan.id);
    }
  }, [groups]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewClass = `view-${ui.mobileView}`;

  return (
    <div id="content">
      <div
        className={`agora-layout ${viewClass}${ui.sideCollapsed ? " side-collapsed" : ""}${ui.threadRoot != null && ui.threadExpanded ? " thread-expanded" : ""}`}
        id="agora-layout">
        <Sidebar />
        {ui.view.kind === "channel" && <ChannelPane />}
        {ui.view.kind === "inbox" && <ThreadsInbox />}
        {ui.view.kind === "group" && <GroupOverview />}
        {ui.threadRoot != null
          ? <ThreadPane />
          : <div className="agora-thread" id="agora-thread" style={{ display: "none" }}></div>}
        <MembersPanel />
      </div>
      <EmojiPickerHost onPick={(mid, emoji) => toggleReaction(mid, emoji)} />
      <SearchPane />
      <PeoplePane />
      <ConnectionsPane />
      <SourcesViewer />
      <AgentProfileCard />
    </div>
  );
}
