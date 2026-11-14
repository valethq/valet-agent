import type { Env } from "./env";
import { type Active, execute, type Job } from "./runner";
import { defaultQueueMode } from "./settings";

export interface Finished {
  sessionId: string;
  messageId: string;
  runId?: string;
}

interface SessionQueue {
  active?: Active;
  pending: Job[];
  draining: boolean;
}

export class RunQueue {
  readonly #env: Env;
  readonly #queues = new Map<string, SessionQueue>();
  readonly #listeners = new Set<(f: Finished) => void>();

  constructor(env: Env) {
    this.#env = env;
  }

  enqueue(job: Job): void {
    const queue = this.#queues.get(job.sessionId) ?? { pending: [], draining: false };
    this.#queues.set(job.sessionId, queue);
    const settings = this.#env.ctx.store.sessions.get(job.sessionId)?.settings.agent as
      | { queueMode?: string }
      | undefined;
    const queueMode = settings?.queueMode ?? defaultQueueMode(this.#env.ctx);
    if (queueMode === "interrupt" && queue.active) {
      queue.pending.unshift(job);
      void this.cancelActive(job.sessionId, this.#env.ctx.plugin.id);
    } else queue.pending.push(job);
    void this.#drain(job.sessionId, queue);
  }

  async cancelActive(sessionId: string, by: string): Promise<boolean> {
    const runId = this.#queues.get(sessionId)?.active?.runId;
    if (!runId) return false;
    try {
      await this.#env.ctx.store.runs.cancel(runId, by);
      return true;
    } catch (error) {
      this.#env.ctx.log.warn("run cancel refused", { runId, error: String(error) });
      return false;
    }
  }

  abort(runId: string): void {
    for (const queue of this.#queues.values()) {
      if (queue.active?.runId === runId) queue.active.controller.abort();
    }
  }

  dropSession(sessionId: string): void {
    const queue = this.#queues.get(sessionId);
    if (!queue) return;
    const dropped = queue.pending;
    queue.pending = [];
    queue.active?.controller.abort();
    for (const job of dropped) for (const fn of this.#listeners) fn({ sessionId, messageId: job.message.id });
  }

  /** Calls `fn` after each job ends, whatever its outcome. Returns the unsubscribe. */
  onFinished(fn: (f: Finished) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  snapshot(sessionId: string): { activeRunId?: string; queued: number } {
    const queue = this.#queues.get(sessionId);
    return {
      ...(queue?.active?.runId ? { activeRunId: queue.active.runId } : {}),
      queued: queue?.pending.length ?? 0,
    };
  }

  async #drain(sessionId: string, queue: SessionQueue): Promise<void> {
    if (queue.draining) return;
    queue.draining = true;
    await this.#setStatus(sessionId, "running");
    try {
      for (let job = queue.pending.shift(); job; job = queue.pending.shift()) {
        queue.active = { controller: new AbortController() };
        try {
          await execute(this.#env, job, queue.active);
        } catch (error) {
          this.#env.ctx.log.error("run failed", { sessionId, error: String(error) });
        }
        const runId = queue.active.runId;
        for (const fn of this.#listeners)
          fn({ sessionId, messageId: job.message.id, ...(runId ? { runId } : {}) });
        queue.active = undefined;
      }
    } finally {
      if (queue.pending.length === 0) await this.#setStatus(sessionId, "idle");
      queue.draining = false;
      if (queue.pending.length === 0) this.#queues.delete(sessionId);
      else void this.#drain(sessionId, queue);
    }
  }

  /** The session's status is owned by the agent: running while a run is active or queued. */
  async #setStatus(sessionId: string, status: "running" | "idle"): Promise<void> {
    const { store } = this.#env.ctx;
    const session = store.sessions.get(sessionId);
    if (session === undefined || session.status === "archived") return;
    await store.sessions.update(sessionId, { status }).catch(() => {});
  }
}
