import type { Env } from "./env";
import { type Active, execute, type Job } from "./runner";

interface SessionQueue {
  active?: Active;
  pending: Job[];
  draining: boolean;
}

export class RunQueue {
  readonly #env: Env;
  readonly #queues = new Map<string, SessionQueue>();

  constructor(env: Env) {
    this.#env = env;
  }

  enqueue(job: Job): void {
    const queue = this.#queues.get(job.sessionId) ?? { pending: [], draining: false };
    this.#queues.set(job.sessionId, queue);
    const settings = this.#env.ctx.store.sessions.get(job.sessionId)?.settings.agent as
      | { queueMode?: string }
      | undefined;
    if (settings?.queueMode === "interrupt" && queue.active) {
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
    try {
      for (let job = queue.pending.shift(); job; job = queue.pending.shift()) {
        queue.active = { controller: new AbortController() };
        try {
          await execute(this.#env, job, queue.active);
        } catch (error) {
          this.#env.ctx.log.error("run failed", { sessionId, error: String(error) });
        }
        queue.active = undefined;
      }
    } finally {
      queue.draining = false;
      if (queue.pending.length === 0) this.#queues.delete(sessionId);
    }
  }
}
