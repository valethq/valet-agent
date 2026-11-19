import type {
  AgentProvider,
  ModelContent,
  ModelInfo,
  ModelOptions,
  ModelProvider,
  ModelRef,
  Store,
} from "@valethq/sdk";
import { runOptions } from "./catalog";
import type { Env } from "./env";
import type { RunCtx } from "./run-types";

const SUMMARY_SYSTEM =
  "Summarize this chat so the assistant can carry on in it later. Keep decisions, open tasks, file paths, names and numbers. Reply with the summary only.";

/** Completed compactions a harness made in this chat. valet's own summaries don't touch a harness's context. */
export function harnessCompactions(store: Store, sessionId: string): string[] {
  const by: string[] = [];
  for (const { parts } of store.messages.list(sessionId))
    for (const { data } of parts)
      if (data.type === "compaction" && data.status === "completed" && data.by !== "valet") by.push(data.by);
  return by;
}

/** `by` holds one entry per completed compaction: names are deduped for the list, the count stays per compaction. */
export function compactionNote(by: string[]): ModelContent {
  const names = [...new Set(by)];
  return {
    type: "text",
    text: `[valet: ${names.join(", ")} compacted your context ${by.length} time(s) in this chat. Turns before the latest compaction reach you only as its summary, so quote them from the summary with that caveat. This is still the same chat, not a new thread.]`,
  };
}

/** One compaction part per harness compaction. Ending a part that isn't open is a no-op, so a harness's own end event can close it first. */
export class CompactionRecorder {
  #id?: string;

  constructor(
    private readonly ctx: Env["ctx"],
    private readonly sessionId: string,
    private readonly by: string,
  ) {}

  get open(): boolean {
    return this.#id !== undefined;
  }

  async start(): Promise<void> {
    if (this.#id !== undefined) return;
    const { compactionId } = await this.ctx.scopes
      .get("context")
      .compactionStart({ sessionId: this.sessionId, by: this.by });
    this.#id = compactionId;
  }

  async end(status: "completed" | "failed" | "cancelled", error?: string): Promise<void> {
    const compactionId = this.#id;
    if (compactionId === undefined) return;
    await this.ctx.scopes.get("context").compactionEnd({
      sessionId: this.sessionId,
      compactionId,
      status,
      ...(error === undefined ? {} : { error }),
    });
    this.#id = undefined;
  }
}

async function summarize(
  provider: ModelProvider,
  model: string,
  options: ModelOptions,
  sessionId: string,
  transcript: string,
  signal: AbortSignal,
): Promise<string> {
  // spec-gap: only finish "stop" is a summary; cancelled, length, and a missing finish are failures.
  if (signal.aborted) throw new Error("summary cancelled");
  let text = "";
  let stopped = false;
  const req = {
    model,
    ...options,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: transcript }] }],
    tools: [],
    meta: { sessionId, runId: "compaction" },
  };
  for await (const chunk of provider.stream(req, signal)) {
    if (signal.aborted) throw new Error("summary cancelled");
    if (chunk.type === "text-delta") text += chunk.text;
    if (chunk.type !== "finish") continue;
    if (chunk.reason === "error") throw new Error(chunk.error ?? "summary failed");
    if (chunk.reason === "cancelled") throw new Error(chunk.error ?? "summary cancelled");
    if (chunk.reason === "length") throw new Error(chunk.error ?? "summary truncated");
    if (chunk.reason !== "stop") throw new Error(chunk.error ?? `summary finished with ${chunk.reason}`);
    stopped = true;
  }
  if (signal.aborted) throw new Error("summary cancelled");
  if (!stopped) throw new Error("summary ended without a finish chunk");
  if (text.trim() === "") throw new Error("the summary came back empty");
  return text.trim();
}

/** valet compacts the chat itself; the summary replaces older turns in valet's history. */
export function compactWithValet(
  env: Env,
  provider: ModelProvider,
  ref: ModelRef,
  info: ModelInfo,
  sessionId: string,
  reason: "auto" | "manual",
  signal: AbortSignal,
): Promise<void> {
  return env.ctx.scopes.get("context").compact({
    sessionId,
    reason,
    summarize: (transcript) =>
      summarize(provider, ref.model, runOptions(ref, info), sessionId, transcript, signal),
  });
}

/** After a model run, compacts once the last request passes the threshold. A failure is a warning in the chat, not a failed run. */
export async function autoCompact(
  env: Env,
  provider: ModelProvider,
  ref: ModelRef,
  info: ModelInfo,
  rc: RunCtx,
  contextTokens: number,
): Promise<void> {
  const shouldCompact = await env.ctx.scopes
    .get("context")
    .shouldCompact({ sessionId: rc.sessionId, model: info, lastUsage: { contextTokens } });
  if (!shouldCompact) return;
  try {
    await compactWithValet(env, provider, ref, info, rc.sessionId, "auto", rc.signal);
  } catch (error) {
    rc.parts.notice(
      "warn",
      `Auto-compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `/compact` on a harness session: the harness compacts its own context; valet only opens and closes the marker. Returns a reply only for a refusal or failure. */
export async function compactHarness(
  env: Env,
  provider: AgentProvider,
  ref: ModelRef,
  info: ModelInfo,
  sessionId: string,
  cwd: string,
  instructions: string | undefined,
): Promise<string | undefined> {
  const entry = await env.agents.acquire(provider, sessionId, cwd, ref.model, runOptions(ref, info));
  const session = entry.session;
  if (!session.compact)
    return `${provider.label} can't be asked to compact. It compacts on its own when it needs to.`;
  const recorder = new CompactionRecorder(env.ctx, sessionId, provider.label);
  await recorder.start();
  let completed = false;
  let error: string | undefined;
  try {
    for await (const ev of session.compact(instructions, env.ctx.signal)) {
      if (ev.type === "compaction-start") await recorder.start();
      if (ev.type === "compaction-end") {
        completed ||= ev.status === "completed";
        await recorder.end(ev.status, ev.error);
      }
      if (ev.type === "finish" && ev.reason === "error") error = ev.error ?? "compaction failed";
    }
  } finally {
    await recorder.end("failed", error ?? "the harness reported no compaction");
  }
  if (error !== undefined) return `Compaction failed: ${error}`;
  // success is shown by the marker itself, so no reply text
  return completed ? undefined : `Compaction failed: ${provider.label} reported no compaction.`;
}
