import type { ModelContent, Store } from "@valethq/sdk";

export function compactionNotices(store: Store, sessionId: string): string[] {
  const texts: string[] = [];
  for (const { parts } of store.messages.list(sessionId))
    for (const { data } of parts)
      if (data.type === "notice" && data.text.startsWith("Context compacted")) texts.push(data.text);
  return texts;
}

export function compactionNote(texts: string[]): ModelContent {
  return {
    type: "text",
    text: `[valet: Devin CLI has compacted your context ${texts.length} time(s) in this chat (${texts.join("; ")}). Turns before the latest compaction reach you only as Devin CLI's summary, so quote them from the summary with that caveat. This is still the same chat, not a new thread.]`,
  };
}
