import type { AgentConfig } from "./model";
import type { Outcome } from "./subagent-text";

export const DEFAULT_WAKE_GROUP_SECONDS = 15;

/** The grouping window in ms from the `subagentWakeGroupSeconds` setting. 0 wakes for every subagent on its own. */
export function wakeGroupMs(config: AgentConfig): number {
  const seconds = config.subagentWakeGroupSeconds;
  const valid = typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
  return (valid ? seconds : DEFAULT_WAKE_GROUP_SECONDS) * 1000;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WakeGroup {
  /** A subagent has ended. */
  add(outcome: Outcome): void;
  /** Posts whatever is waiting now. Does nothing when nothing is. */
  flush(): void;
}

/**
 * Gathers the subagents that end close together into one wake-up. The first to end starts a timer of `windowMs()`;
 * each one that ends while it runs adds another window to it. The group posts when the timer runs out, or at once
 * when none are left (`remaining()` is 0), and the next to end starts a new group. A window of 0 posts every
 * subagent on its own.
 */
export function wakeGroup(
  opts: {
    windowMs(): number;
    remaining(): number;
    post(outcomes: Outcome[], remaining: number): void;
  },
  clock: Clock = realClock,
): WakeGroup {
  let pending: Outcome[] = [];
  let timer: unknown;
  let deadline = 0;

  const flush = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    if (pending.length === 0) return;
    const outcomes = pending;
    pending = [];
    opts.post(outcomes, opts.remaining());
  };

  return {
    flush,
    add(outcome) {
      pending.push(outcome);
      const window = opts.windowMs();
      if (window <= 0 || opts.remaining() === 0) return flush();
      const now = clock.now();
      deadline = timer === undefined ? now + window : deadline + window;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = clock.setTimeout(flush, Math.max(0, deadline - now));
    },
  };
}
