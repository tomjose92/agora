/* Payload shapes mirrored from crates/agora-core/src/{server,store,hub}.rs.
   There is no shared schema with the Rust server; the integration tests are
   what keep these honest. */

export interface Me {
  username: string;
  display_name?: string;
  /** Operator powers: connections, pairing tokens, users & invites. */
  instance_admin?: boolean;
  version: string;
  /** Server has OPENAI_API_KEY: voice notes / speak-aloud / live voice work. */
  voice?: boolean;
  /** Server has ANTHROPIC_API_KEY: /api/search/ask (Ask AI) works. */
  search_ai?: boolean;
}

/** One workspace account from GET /api/users (any signed-in user may list
    them — it feeds the add-person picker). */
export interface UserInfo {
  username: string;
  display_name: string;
  email: string | null;
  instance_role: "admin" | "member";
  created_at: number;
  disabled: boolean;
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

/** One element of an interactive form (meta.form): a text input or a
    checkbox. `value` is the agent-supplied initial value; the live values
    everyone shares live in meta.form_state, keyed by field id. */
export interface FormField {
  id: string;
  kind: "input" | "checkbox";
  label: string;
  placeholder?: string;
  value?: string | boolean;
}

export interface FormButton {
  id: string;
  label: string;
  style?: "primary" | "secondary" | string;
}

/** An agent-authored interactive form rendered inside the message bubble.
    Shared, one-shot: any member edits the same state, the first button
    press locks it (meta.form_submitted) for everyone. */
export interface MessageForm {
  fields: FormField[];
  buttons: FormButton[];
}

/** Link metadata for source chips and unfurl cards. Entries start as bare
    URLs; the server enriches them asynchronously (title/description/image
    arrive on a message_update once the page is fetched). */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  site?: string;
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
  /* Agent-supplied short version of a long message; the UI can swap the
     bubble between it and the full text. */
  tldr?: string;
  /* Cited URLs — sent structured by the agent or lifted server-side from a
     trailing "Sources:" block; rendered as chips + viewer, never raw. */
  sources?: LinkPreview[];
  /* UTF-16 offset into `text` where a detected trailing sources block
     starts (String.slice units); clients cut the text there. */
  sources_start?: number;
  /* Server-fetched previews for (non-source) links in the prose. */
  unfurls?: LinkPreview[];
  /* Interactive form: spec, shared live values, and the one-shot lock. */
  form?: MessageForm;
  form_id?: string;
  form_state?: Record<string, string | boolean>;
  form_submitted?: {
    button_id: string;
    by?: string;
    ts?: number;
    values?: Record<string, string | boolean>;
  } | null;
}

/** One emoji's reactions on a message; users in reaction order, so the
    count is `users.length` and "did I react" is a membership test. */
export interface Reaction {
  emoji: string;
  users: string[];
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
  reactions?: Reaction[];
  meta?: MessageMeta | null;
  /* Top-level pages only. */
  reply_count?: number;
  /* Thread roots only: a user-chosen display name, else null. */
  alias?: string | null;
}

/** Message hit from GET /api/search. Search rows carry channel/group names
    for breadcrumbs and a `snippet` with matched terms wrapped in
    U+0001…U+0002, plus the message's `attachments` (filenames are searchable
    and the file filter matches on them). */
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

/** A message was deleted (sender or an admin). A null thread_id means a
    top-level message went — roots take their whole thread with them. */
export interface MessageDeleteEvent {
  type: "message_delete";
  channel_id: string;
  message_id: number;
  thread_id: number | null;
}

export type WsEvent =
  | TypingEvent
  | ProgressEvent
  | MessageEvent
  | MessageUpdateEvent
  | MessageDeleteEvent
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

export interface InstanceInfo {
  id: string;
  name: string;
}

export interface Invite {
  email: string;
  instance_role: string;
  invited_by?: string | null;
  accepted_at?: number | null;
}

export interface InviteLink {
  token: string;
  url: string;
  instance_role: string;
  invited_by?: string | null;
  used_by?: string | null;
  expires_at: number;
}
