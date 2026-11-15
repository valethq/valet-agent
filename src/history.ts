import type { ModelContent, Store } from "@valethq/sdk";
import { isNotification } from "./content";

const MAX_CHARS = 60_000;
const label: Record<string, string> = { user: "User", assistant: "Assistant" };

/**
 * The chat before `beforeSeq` as one text block, for a harness session that starts fresh in a chat that already has
 * turns (a fork, a move, or a reseed). Starts after the latest valet summary. Undefined when there is nothing before.
 */
export function historyNote(store: Store, sessionId: string, beforeSeq: number): ModelContent | undefined {
  const entries = store.messages.list(sessionId, { beforeSeq });
  let summary: { text: string; through: number } | undefined;
  for (const { parts } of entries)
    for (const { data } of parts)
      if (data.type === "compaction" && data.status === "completed" && data.summary)
        summary = { text: data.summary, through: data.coversThroughSeq };
  const lines: string[] = [];
  for (const { message, parts } of entries) {
    if (summary && message.seq <= summary.through) continue;
    if (message.role !== "user" && message.role !== "assistant" && !isNotification(store, message, parts))
      continue;
    const text = parts
      .flatMap(({ data }) => (data.type === "text" || data.type === "custom" ? [data.text] : []))
      .join("\n")
      .trim();
    if (text) lines.push(`${label[message.role] ?? "Notification"}: ${text}`);
  }
  if (lines.length === 0 && !summary) return undefined;
  let transcript = lines.join("\n\n");
  if (transcript.length > MAX_CHARS) transcript = `[earlier turns cut]\n${transcript.slice(-MAX_CHARS)}`;
  const head = summary ? `Summary of earlier turns:\n${summary.text}\n\n` : "";
  return {
    type: "text",
    text: `[valet: you are joining a chat that already has turns (it was forked, moved or reseeded), so your context starts empty. ${head}Transcript before this message:\n${transcript}\n(end of transcript)]`,
  };
}
