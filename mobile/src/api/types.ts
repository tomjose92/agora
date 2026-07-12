/* Payload shapes mirrored from crates/agora-core/src/{server,store,hub}.rs.
   There is no shared schema with the Rust server; the integration tests are
   what keep these honest. */

export interface Me {
  username: string;
  version: string;
  /** Server has OPENAI_API_KEY: voice notes / speak-aloud / live voice work. */
  voice?: boolean;
  /** Server has ANTHROPIC_API_KEY: /api/search/ask (Ask AI) works. */
  search_ai?: boolean;
}

export interface Channel {
  id: string;
  group_id: string;
  name: string;
  topic: string;
  created_at: number;
  /** Tucked away in the home list (admin toggle); data is untouched. */
  hidden?: boolean;
  /* Embedded by the groups endpoint only. `unread` counts top-level
     messages; `mentions` counts @you messages (any thread). */
  unread?: number;
  mentions?: number;
  last_read_id?: number;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: number;
  channels: Channel[];
  role: "admin" | "member";
  /** Tucked away in the home list (admin toggle); data is untouched. */
  hidden?: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
}

export interface MessageOption {
  id: string;
  label: string;
  style?: "primary" | "danger" | "default" | string;
}

export interface MessageMeta {
  options?: MessageOption[];
  options_id?: string;
  resolved?: {
    option_id: string;
    by?: string;
    label?: string;
    ts?: number;
  } | null;
}

export interface Message {
  id: number;
  channel_id: string;
  thread_id: number | null;
  author_type: "user" | "agent";
  author_id: string;
  author_name: string | null;
  text: string;
  ts: number;
  attachments: Attachment[];
  meta?: MessageMeta | null;
  /* Top-level pages only. */
  reply_count?: number;
  /* Thread roots only: a user-chosen display name, else null. */
  alias?: string | null;
}

/** Message hit from GET /api/search. Search rows carry channel/group names
    for breadcrumbs and a `snippet` with matched terms wrapped in
    U+0001…U+0002 — but no attachments (store::search_messages). */
export interface SearchMessageHit extends Omit<Message, "attachments"> {
  attachments?: Attachment[];
  channel_name: string;
  group_id: string;
  group_name: string;
  snippet: string;
}

export interface SearchChannelHit {
  id: string;
  group_id: string;
  name: string;
  topic: string;
  hidden: boolean;
  group_name: string;
}

export interface SearchGroupHit {
  id: string;
  name: string;
  description: string;
  hidden: boolean;
}

export interface SearchMessagesPage {
  items: SearchMessageHit[];
  has_more: boolean;
  offset: number;
}

/** GET /api/search — sections are present only for the requested `types`. */
export interface SearchResponse {
  query: string;
  messages?: SearchMessagesPage;
  channels?: SearchChannelHit[];
  groups?: SearchGroupHit[];
}

/** POST /api/search/ask — [n] in `answer` cites sources[n-1]; a null answer
    means no matching messages (`detail` explains). */
export interface AskResponse {
  answer: string | null;
  model?: string;
  sources: SearchMessageHit[];
  detail?: string;
}

/** One row of GET /api/threads: a thread the user participates in. */
export interface ThreadRow {
  root: Message;
  channel_id: string;
  channel_name: string;
  group_id: string;
  group_name: string;
  reply_count: number;
  last_reply_id: number;
  last_reply_ts: number;
  last_read_id: number;
  unread: number;
}

export interface StarredMessage extends Message {
  starred_at: number;
  root: Message | null;
}

export interface PinnedMessage extends Message {
  pinned_by: string | null;
  pinned_at: number;
}

export interface Member {
  channel_id: string | null;
  member_type: "user" | "agent";
  member_id: string;
  role: string;
  added_at: number;
  /* Agents get their display name resolved server-side. */
  name?: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  source: string;
  requires_mention: boolean;
  last_seen: number;
  live: boolean;
  avatar: string | null;
}

export interface ChannelAgent {
  id: string;
  name: string;
}

export interface TypingEvent {
  type: "typing";
  channel_id: string;
  thread_id: number | null;
  agent_id: string;
  agent_name: string;
  active: boolean;
}

export interface ProgressEvent {
  type: "progress";
  channel_id: string;
  thread_id: number | null;
  agent_id: string;
  agent_name: string;
  handle: string;
  text: string;
}

export interface MessageEvent {
  type: "message";
  message: Message;
}

export interface ReadEvent {
  type: "read";
  channel_id: string;
  last_read_id: number;
}

export interface ThreadReadEvent {
  type: "thread_read";
  thread_id: number;
  channel_id: string;
  last_read_id: number;
}

export interface ThreadRenamedEvent {
  type: "thread_renamed";
  thread_id: number;
  channel_id: string;
  alias: string | null;
}

export interface PinEvent {
  type: "pin";
  channel_id: string;
  pinned: boolean;
  pin?: PinnedMessage;
  message_id?: number;
}

export interface MessageUpdateEvent {
  type: "message_update";
  message: Message;
}

export type WsEvent =
  | TypingEvent
  | ProgressEvent
  | MessageEvent
  | MessageUpdateEvent
  | ReadEvent
  | ThreadReadEvent
  | ThreadRenamedEvent
  | PinEvent;

export interface ChannelActivity {
  typing: TypingEvent[];
  progress: ProgressEvent[];
}

export interface ConnStatus {
  name: string;
  url: string;
  connected: boolean;
  agents: { id: string; name: string }[];
  last_error: string | null;
}

export interface Connection {
  name: string;
  url: string;
  enabled: boolean;
  status: ConnStatus | null;
}

export interface PairingToken {
  token: string;
  name: string;
  created_at: number;
}
