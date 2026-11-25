import {
  AgentOperationError,
  type AgentSubject,
  type Caller,
  can,
  type ResourceScope,
  ServiceDeniedError,
  sessionResource,
} from "@valethq/sdk";
import { compactSession } from "./compact";
import type { Env } from "./env";
import { forkSession } from "./fork";
import { resolveModel } from "./model";
import { moveDenied, moveSession } from "./move";
import type { RunQueue } from "./queue";

/** The provider's own caller combined with the subject the consuming plugin delegated. */
const callerOf = (caller: Caller, subject: AgentSubject | undefined): Caller =>
  subject ? { ...subject, plugin: caller.plugin } : caller;

const storeFor = (env: Env, subject: AgentSubject | undefined) => {
  const principalId = subject?.actor?.principalId;
  return principalId && env.ctx.store.principals.get(principalId)
    ? env.ctx.store.as({ principalId })
    : env.ctx.store;
};

const deny = (env: Env, caller: Caller, resource: ResourceScope): void => {
  const decision = can(env.ctx, caller, "core:session.write", resource);
  if (!decision.allow) throw new ServiceDeniedError(decision.reason);
};

/** Store and harness failures keep their meaning across the scope boundary instead of surfacing as 500s. */
const operational = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AgentOperationError || error instanceof ServiceDeniedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/^unknown (session|message|project)$/.test(message) || /has no messages/.test(message))
      throw new AgentOperationError("not_found", message);
    if (/turn is running/.test(message)) throw new AgentOperationError("busy", message);
    if (/already in that project/.test(message)) throw new AgentOperationError("bad_request", message);
    throw error;
  }
};

/**
 * agent@1: the session operations any consumer needs, whichever plugin provides them. The factory's caller
 * names the consumer; `subject` carries the authenticated principal behind its request.
 */
export function provideAgent(env: Env, queue: RunQueue): void {
  const { ctx } = env;
  ctx.scopes.define({ name: "agent", version: 1, cardinality: "one" });
  ctx.scopes.provide("agent", (caller) => ({
    models: () => env.catalog.providers(),

    state: (sessionId) => {
      const session = ctx.store.sessions.get(sessionId);
      if (!session) return undefined;
      const usage = env.lastUsage.get(sessionId);
      const { fallbacks: _f, ...model } = env.catalog.normalize(
        resolveModel(session, ctx.store.projects.get(session.projectId), ctx.config),
      );
      return { ...queue.snapshot(sessionId), model, ...(usage ? { usage } : {}) };
    },

    fork: (sessionId, opts) =>
      operational(async () => {
        deny(env, callerOf(caller, opts?.subject), sessionResource(ctx, sessionId));
        return forkSession(storeFor(env, opts?.subject), sessionId, opts?.messageId);
      }),

    move: (sessionId, projectId, opts) =>
      operational(async () => {
        const effective = callerOf(caller, opts?.subject);
        const source = ctx.store.sessions.get(sessionId);
        if (!source) throw new AgentOperationError("not_found", "unknown session");
        const denied = moveDenied(ctx, effective, ctx.store, source, projectId);
        if (denied) throw new ServiceDeniedError(denied.reason);
        const { activeRunId, queued } = queue.snapshot(sessionId);
        return moveSession(
          storeFor(env, opts?.subject),
          sessionId,
          projectId,
          activeRunId !== undefined || queued > 0,
        );
      }),

    compact: (sessionId, opts) =>
      operational(async () => {
        deny(env, callerOf(caller, opts?.subject), sessionResource(ctx, sessionId));
        const result = await compactSession(env, queue, sessionId, opts?.instructions, "manual");
        if (result.text === undefined) return;
        throw new AgentOperationError(result.unsupported ? "unsupported" : "bad_request", result.text);
      }),
  }));
}
