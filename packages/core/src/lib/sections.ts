/* Shared conversational-section derivation for navigation rails. Keeping
   the boundary and label rules here prevents web and native from drifting. */

import type { Message } from "../api/types";

export interface ConversationSection {
  mid: number;
  label: string;
}

function firstLine(text: string, max = 64): string {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  return compact.length > max
    ? `${compact.slice(0, max - 1).trimEnd()}…`
    : compact;
}

/** A section starts at the first message and at every user message after it. */
export function conversationSections(
  messages: Message[],
): ConversationSection[] {
  const sections: ConversationSection[] = [];
  for (const message of messages) {
    if (sections.length === 0 || message.author_type === "user") {
      const who = message.author_name || message.author_id;
      const body = firstLine(message.text);
      sections.push({ mid: message.id, label: body ? `${who}: ${body}` : who });
    }
  }
  return sections;
}
