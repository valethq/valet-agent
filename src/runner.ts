import type { Message, Part, Role, Run, Store } from "@valethq/sdk";
import { runAgent } from "./agent-run";
import { toContent } from "./content";
import type { Env } from "./env";
import { type ModelRef, refOf, resolveModel } from "./model";
import { runModel } from "./model-run";
import { PartStream } from "./parts";
import type { Outcome, RunCtx } from "./run-types";

export interface Job {
  sessionId: string;
  message: Message;
  parts: Part[];
  role: Role;
}
export interface Active {
  controller: AbortController;
  runId?: string;
  /** The user message this job is answering. */
  messageId: string;
}

type Ending = { message: "complete" | "error" | "interrupted"; run: Run["status"] };
const ENDINGS: Record<Outcome["status"] | "interrupted", Ending> = {
  stop: { message: "complete", run: "complete" },
  cancelled: { message: "interrupted", run: "cancelled" },
  error: { message: "error", run: "error" },
  interrupted: { message: "interrupted", run: "interrupted" },
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// spec-gap: a throw after the model loop still has to leave the run and its assistant message terminal.
async function recover(
  store: Store,
  sessionId: string,
  runId: string,
  parts: PartStream,
  messageId: string | undefined,
  status: "error" | "interrupted",
  error: string,
): Promise<void> {
  const id = messageId ?? (await parts.finish().catch(() => undefined));
  const entries = store.messages.list(sessionId);
  const entry =
    (id !== undefined ? entries.find((e) => e.message.id === id) : undefined) ??
    entries.find(
      (e) => e.message.role === "assistant" && e.message.runId === runId && e.message.status === "streaming",
    );
  const target = id ?? entry?.message.id;
  if (target !== undefined && (entry === undefined || entry.message.status === "streaming")) {
    const other = status === "error" ? "interrupted" : "error";
    await store.messages
      .complete(target, status)
      .catch(() => store.messages.complete(target, other).catch(() => {}));
  }
  if (store.runs.get(runId)?.status === "running") store.runs.update(runId, { status: "error", error });
}

async function attempt(
  env: Env,
  cand: ModelRef,
  rc: RunCtx,
  contextWindow: { value?: number },
  used: { value?: ModelRef },
): Promise<Outcome> {
  const provider = env.ctx.scopes.maybe("inference", cand.provider);
  if (!provider) return { status: "error", error: `no inference provider "${cand.provider}"` };
  used.value = refOf(cand);
  rc.store.runs.update(rc.runId, { provider: cand.provider, model: cand.model });
  try {
    const info = await env.catalog.info(cand);
    contextWindow.value = info.contextWindow || undefined;
    const outcome =
      provider.kind === "agent"
        ? await runAgent(env, provider, cand, rc, info)
        : await runModel(env, provider, cand, rc, info);
    if (outcome.status === "error" && provider.kind === "agent") await env.agents.drop(rc.sessionId);
    return outcome;
  } catch (error) {
    if (provider.kind === "agent") await env.agents.drop(rc.sessionId);
    return rc.signal.aborted ? { status: "cancelled" } : { status: "error", error: errorText(error) };
  }
}

export async function execute(env: Env, job: Job, active: Active): Promise<void> {
  const { ctx } = env;
  const session = ctx.store.sessions.get(job.sessionId);
  if (!session) return;
  const project = ctx.store.projects.get(session.projectId);
  const author = job.message.authorPrincipalId;
  const store =
    author && ctx.store.principals.get(author) ? ctx.store.as({ principalId: author }) : ctx.store;

  const run = store.runs.create({ sessionId: session.id, triggerMessageId: job.message.id, role: job.role });
  active.runId = run.id;
  store.runs.update(run.id, { status: "running" });

  const used: { value?: ModelRef } = {};
  let createError = "assistant message was cancelled";
  const parts = new PartStream(store, () =>
    store.messages
      .create({
        sessionId: session.id,
        role: "assistant",
        runId: run.id,
        status: "streaming",
        parts: [],
        ...(used.value ? { meta: { model: used.value } } : {}),
      })
      .then(
        (res) => {
          if ("cancelled" in res) {
            if (res.cancelReason) createError = res.cancelReason;
            return undefined;
          }
          return res.message.id;
        },
        (error) => {
          createError = errorText(error);
          return undefined;
        },
      ),
  );
  const signal = AbortSignal.any([ctx.signal, active.controller.signal]);
  const usage: Record<string, number> = {};
  const contextWindow: { value?: number } = {};
  const rc: RunCtx = {
    sessionId: session.id,
    projectId: session.projectId,
    cwd: project?.workspaceDir ?? ctx.paths.data,
    runId: run.id,
    triggerSeq: job.message.seq,
    role: job.role,
    caller: { plugin: ctx.plugin.id, ...(author ? { actor: { principalId: author, role: job.role } } : {}) },
    content: toContent(job.parts),
    parts,
    signal,
    store,
    usage(u) {
      for (const [k, v] of Object.entries(u)) if (typeof v === "number") usage[k] = v;
      if (contextWindow.value) usage.contextWindow = contextWindow.value;
      env.lastUsage.set(session.id, usage);
      store.runs.update(run.id, { usage });
    },
  };

  const failures: { cand: ModelRef; error: string }[] = [];
  let outcome: Outcome = { status: "error", error: "no model candidates" };
  try {
    const resolved = resolveModel(session, project, ctx.config);
    const setting = {
      ...env.catalog.normalize(resolved),
      fallbacks: resolved.fallbacks.map((f) => env.catalog.normalize(f)),
    };
    for (const cand of [setting, ...setting.fallbacks]) {
      if (signal.aborted) {
        outcome = { status: "cancelled" };
        break;
      }
      outcome = await attempt(env, cand, rc, contextWindow, used);
      if (outcome.status !== "error" || parts.output) break;
      failures.push({ cand, error: outcome.error });
      ctx.log.warn("model attempt failed, trying next fallback", { runId: run.id, error: outcome.error });
    }
  } catch (error) {
    outcome = { status: "error", error: errorText(error) };
  }

  const ended = ctx.signal.aborted ? ENDINGS.interrupted : ENDINGS[outcome.status];
  let messageId: string | undefined;
  try {
    if (ended.message === "error" && !parts.output && outcome.status === "error") {
      parts.notice("error", outcome.error);
    } else if (ended.message === "complete" && failures.length > 0 && used.value) {
      const failed = failures.map((f) => `${f.cand.provider}:${f.cand.model} failed: ${f.error}`).join("; ");
      parts.notice("warn", `${failed}; used ${used.value.provider}:${used.value.model}`);
    }
    parts.closeAll(ended.message);
    messageId = await parts.finish();
    if (messageId === undefined) {
      if (store.runs.get(run.id)?.status === "running")
        store.runs.update(run.id, { status: "error", error: createError });
      return;
    }
    await store.messages.complete(messageId, ended.message);
    if (store.runs.get(run.id)?.status === "running") {
      store.runs.update(run.id, {
        status: ended.run,
        ...(outcome.status === "error" ? { error: outcome.error } : {}),
      });
    }
  } catch (error) {
    const status = ended.message === "interrupted" ? "interrupted" : "error";
    await recover(store, session.id, run.id, parts, messageId, status, errorText(error));
  }
}
