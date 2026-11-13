import type { ModelContent, ModelInfo, ModelProvider, Store } from "@valethq/sdk";
import type { Env } from "./env";
import type { RunCtx } from "./run-types";

const SUMMARY_SYSTEM =
  "Summarize this chat so the assistant can carry on in it later. Keep decisions, open tasks, file paths, names and numbers. Reply with the summary only.";

/** Compactions a harness made in this chat. valet's own summaries don't touch a harness's context. */
export function harnessCompactions(store: Store, sessionId: string): string[] {
  const by: string[] = [];
  for (const { parts } of store.messages.list(sessionId))
    for (const { data } of parts) if (data.type === "compaction" && data.by !== "valet") by.push(data.by);
  return by;
}

export function compactionNote(by: string[]): ModelContent {
  return {
    type: "text",
    text: `[valet: ${by.join(", ")} compacted your context ${by.length} time(s) in this chat. Turns before the latest compaction reach you only as its summary, so quote them from the summary with that caveat. This is still the same chat, not a new thread.]`,
  };
}

async function summarize(
  provider: ModelProvider,
  model: string,
  sessionId: string,
  transcript: string,
  signal: AbortSignal,
): Promise<string> {
  let text = "";
  const req = {
    model,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: transcript }] }],
    tools: [],
    meta: { sessionId, runId: "compaction" },
  };
  for await (const chunk of provider.stream(req, signal)) {
    if (chunk.type === "text-delta") text += chunk.text;
    if (chunk.type === "finish" && chunk.reason === "error") throw new Error(chunk.error ?? "summary failed");
  }
  if (text.trim() === "") throw new Error("the summary came back empty");
  return text.trim();
}

/** valet compacts the chat itself; the summary replaces older turns in valet's history. */
export function compactWithValet(
  env: Env,
  provider: ModelProvider,
  model: string,
  sessionId: string,
  reason: "auto" | "manual",
  signal: AbortSignal,
): Promise<void> {
  return env.ctx.scopes.get("context").compact({
    sessionId,
    reason,
    by: {
      kind: "valet",
      summarize: (transcript) => summarize(provider, model, sessionId, transcript, signal),
    },
  });
}

/** After a model run, compacts once the last request passes the threshold. A failure is a warning in the chat, not a failed run. */
export async function autoCompact(
  env: Env,
  provider: ModelProvider,
  info: ModelInfo,
  rc: RunCtx,
  contextTokens: number,
): Promise<void> {
  const shouldCompact = await env.ctx.scopes
    .get("context")
    .shouldCompact({ sessionId: rc.sessionId, model: info, lastUsage: { contextTokens } });
  if (!shouldCompact) return;
  try {
    await compactWithValet(env, provider, info.id, rc.sessionId, "auto", rc.signal);
  } catch (error) {
    rc.parts.notice(
      "warn",
      `Auto-compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
