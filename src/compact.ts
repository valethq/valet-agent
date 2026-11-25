import { AgentOperationError, type ModelInfo, type ModelRef } from "@valethq/sdk";
import { compactHarness, compactWithValet } from "./compactions";
import type { Env } from "./env";
import { resolveModel } from "./model";
import type { RunQueue } from "./queue";

export interface CompactRun {
  ref: ModelRef;
  info: ModelInfo;
  /** Reply text when the harness refused or failed; undefined when it compacted. */
  text?: string;
  unsupported?: boolean;
}

/**
 * Compacts one chat through the model it resolves to. Queued prompts wait on the session lock so they
 * never share the harness session with the compaction. `reason` is "manual" for `/compact` and the scope.
 */
export async function compactSession(
  env: Env,
  queue: RunQueue,
  sessionId: string,
  instructions: string | undefined,
  reason: "auto" | "manual",
): Promise<CompactRun> {
  const { store } = env.ctx;
  const session = store.sessions.get(sessionId);
  if (!session) throw new AgentOperationError("not_found", "unknown session");
  const release = await queue.beginCompact(sessionId);
  try {
    if (queue.snapshot(sessionId).activeRunId)
      throw new AgentOperationError("busy", "a turn is running; compact once it finishes");
    const project = store.projects.get(session.projectId);
    const ref = env.catalog.normalize(resolveModel(session, project, env.ctx.config));
    const info = await env.catalog.info(ref);
    const provider = env.ctx.scopes.maybe("inference", ref.provider);
    if (!provider) throw new AgentOperationError("unsupported", `no inference provider "${ref.provider}"`);

    if (provider.kind === "model") {
      await compactWithValet(env, provider, ref, info, sessionId, reason, env.ctx.signal);
      return { ref, info };
    }
    const outcome = await compactHarness(
      env,
      provider,
      ref,
      info,
      sessionId,
      project?.workspaceDir ?? env.ctx.paths.data,
      instructions,
    );
    return { ref, info, ...outcome };
  } finally {
    release();
  }
}
