import type { Session, Store, ToolDefinition, ToolResult } from "@valethq/sdk";
import type { Catalog } from "./catalog";
import type { AgentCtx } from "./env";
import type { RunQueue } from "./queue";
import { roleAtLeast } from "./role";
import { type Batch, startBatch } from "./subagent-batch";
import { announce, elapsed } from "./subagent-notify";
import { wakeGroup, wakeGroupMs } from "./subagent-wake";
import { type Outcome, outcomeText, type Task, titleOf } from "./subagent-text";

const MAX_DEPTH = 3;
const MAX_TASKS = 8;
const MAX_STAGE = 99;
/** How long a call waits for its subagents by default. Longer waits risk a harness cutting a silent tool call. */
const DEFAULT_YIELD_MS = 90_000;
const MAX_YIELD_MS = 240_000;

const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** The `tasks` input as ordered tasks, or the first problem with it. */
function parseTasks(input: { tasks?: unknown }): Task[] | string {
  const raw = input.tasks;
  if (!Array.isArray(raw) || raw.length === 0) return "tasks must be a non-empty array";
  if (raw.length > MAX_TASKS) return `at most ${MAX_TASKS} tasks per call`;
  const tasks: Task[] = [];
  const sessions = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) return `tasks[${index}] must be an object`;
    const t = item as Record<string, unknown>;
    const prompt = str(t.prompt);
    if (prompt === undefined) return `tasks[${index}].prompt is required`;
    const stage = t.stage ?? 1;
    if (typeof stage !== "number" || !Number.isInteger(stage) || stage < 1 || stage > MAX_STAGE)
      return `tasks[${index}].stage must be a whole number from 1 to ${MAX_STAGE}`;
    const session = str(t.session);
    if (session !== undefined) {
      if (sessions.has(session))
        return `tasks[${index}] continues ${session}, which another task already does`;
      sessions.add(session);
    }
    const title = str(t.title);
    const model = str(t.model);
    tasks.push({
      index,
      prompt,
      stage,
      ...(title ? { title } : {}),
      ...(session ? { session } : {}),
      ...(model ? { model } : {}),
    });
  }
  return tasks;
}

/** The wait in ms: the default when unset, otherwise the asked value capped at MAX_YIELD_MS; or the problem with it. */
function parseYield(raw: unknown): number | string {
  if (raw === undefined) return DEFAULT_YIELD_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)
    return "yieldMs must be a number of milliseconds, 0 or more";
  return Math.min(raw, MAX_YIELD_MS);
}

function depthOf(store: Store, session: Session): number {
  let depth = 0;
  for (let s: Session | undefined = session; s?.parentSessionId && depth <= MAX_DEPTH; depth++)
    s = store.sessions.get(s.parentSessionId);
  return depth;
}

/**
 * What the call returns when subagents are still running: where each one is, the replies of those that already
 * ended (nothing wakes the chat for them), and that the rest will wake it as they end.
 */
function backgrounded(batch: Batch, waited: number, ended: Map<Task, Outcome>): ToolResult {
  const state = batch.progress();
  const lines = state.map(({ task, session }) => {
    const title = titleOf({ task, ...(session ? { session } : {}) });
    const where = session ? ` [session ${session.id}]` : "";
    const outcome = ended.get(task);
    if (outcome) return `- ${title}: ${outcome.status === "complete" ? "finished" : outcome.status}${where}`;
    return session ? `- ${title}: running${where}` : `- ${title}: not started yet (stage ${task.stage})`;
  });
  const replies = [...ended.values()];
  const text =
    `Still running after ${elapsed(waited)}: ${state.length - replies.length} of ${state.length} subagents continue in the background. ` +
    "You will be notified in this session as they end (ones that end close together arrive in one notification), " +
    "and that starts a new turn if you are idle, so end your turn unless you have other work: do not poll or sleep.\n" +
    `${lines.join("\n")}\n` +
    'Pass a session id as a task\'s "session" to continue a subagent once it has ended.' +
    (replies.length > 0 ? `\n\nAlready ended:\n\n${outcomeText(replies)}` : "");
  return {
    content: [{ type: "text", text }],
    meta: {
      background: true,
      sessions: state.flatMap(({ task, session }) =>
        session ? [{ sessionId: session.id, status: ended.get(task)?.status ?? "running" }] : [],
      ),
      presented: replies.flatMap((o) => o.presented),
    },
  };
}

/**
 * Starts or continues child sessions (parentSessionId = this chat), runs one turn in each with this run's role,
 * and returns their replies. Tasks in the same stage run at once; stages run in ascending order. The call waits
 * up to `yieldMs`; subagents still running then carry on in the background and wake the chat as they end, grouped
 * by the `subagentWakeGroupSeconds` setting.
 */
export function subagentTool(
  ctx: AgentCtx,
  queue: RunQueue,
  catalog: Catalog,
): ToolDefinition<{ tasks?: unknown; yieldMs?: unknown }> {
  return {
    name: "subagent",
    description:
      "Hand self-contained tasks to subagents: child sessions of this chat, each with its own context and the same tools. " +
      "Pass every task in one call as `tasks`. By default they all run at once (in parallel). " +
      "Give tasks a `stage` number to order them: tasks sharing a stage run together, and stage 2 starts only after stage 1 has finished. " +
      `The call waits up to yieldMs (default ${DEFAULT_YIELD_MS / 1000}s, max ${MAX_YIELD_MS / 1000}s). If every subagent has ended by then, you get each one's final reply plus its session id. ` +
      "If not, you get the replies of those that have ended and the session ids of the rest, which keep running in the background; as each of those ends you are notified in this session with its reply (ones that end close together arrive in one notification), " +
      "which starts a new turn if you are idle, so end your turn unless you have other work, and do not poll or sleep. " +
      "Stopping the call during the wait stops the subagents; once they are in the background, stop one by interrupting its own session. " +
      "Pass a session id as a task's `session` to send that subagent a follow-up. " +
      "A subagent can't see this chat, so put everything it needs in its `prompt`.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TASKS,
          description: "The subagents to run. One entry is fine for a single task.",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "The task, with all the context the subagent needs." },
              title: { type: "string", description: "Short title for a new subagent session." },
              stage: {
                type: "integer",
                minimum: 1,
                description:
                  "Order: lower stages finish before higher ones start. Default 1, so everything runs in parallel.",
              },
              session: {
                type: "string",
                description: "A subagent session id from an earlier call, to continue it.",
              },
              model: {
                type: "string",
                description:
                  'Model for a new subagent: "model" or "provider:model", optionally followed by an effort and "fast", e.g. "claude-code:claude-opus-5-5 high". Defaults to this chat\'s.',
              },
            },
            required: ["prompt"],
          },
        },
        yieldMs: {
          type: "number",
          description: `How long to wait for the subagents before they continue in the background. Default ${DEFAULT_YIELD_MS}, max ${MAX_YIELD_MS}.`,
        },
      },
      required: ["tasks"],
    },
    async invoke(input, call) {
      if (!roleAtLeast(call.role, "owner")) return failure("subagent is not available to this role");
      const tasks = parseTasks(input);
      if (typeof tasks === "string") return failure(tasks);
      const yieldMs = parseYield(input.yieldMs);
      if (typeof yieldMs === "string") return failure(yieldMs);
      const parent = ctx.store.sessions.get(call.sessionId);
      if (!parent) return failure("unknown session");
      for (const t of tasks) {
        if (t.session !== undefined && ctx.store.sessions.get(t.session)?.parentSessionId !== parent.id)
          return failure(`${t.session} is not a subagent of this chat`);
      }
      if (tasks.some((t) => t.session === undefined) && depthOf(ctx.store, parent) >= MAX_DEPTH)
        return failure(`subagents nest at most ${MAX_DEPTH} deep`);

      const author = call.caller.actor?.principalId;
      // the wake-up run takes its author's role, so without a known author the call has to wait for the replies
      const notifyAs = author !== undefined && ctx.store.principals.get(author) ? author : undefined;
      const startedAt = Date.now();
      const controller = new AbortController();
      // spec-gap: the spec has no background subagents; this follows valet-exec's job-end notification (9.4).
      // "waiting" until the call returns the replies ("inline") or hands the batch to the background; set where
      // each happens. `reported` is what had ended by the hand-off: its replies go in that result, and only
      // subagents that end after it wake the chat.
      let state: "waiting" | "inline" | "background" = "waiting";
      const reported = new Map<Task, Outcome>();
      const wake = wakeGroup({
        windowMs: () => wakeGroupMs(ctx.config),
        remaining: () => batch.remaining(),
        post: (outcomes, remaining) => {
          if (notifyAs !== undefined)
            void announce(ctx, {
              sessionId: parent.id,
              principalId: notifyAs,
              outcomes,
              remaining,
              startedAt,
            });
        },
      });
      const batch = startBatch(
        {
          ctx,
          queue,
          catalog,
          parent,
          runId: call.runId,
          ...(author ? { author } : {}),
          tasks,
          onEnded: (outcome) => {
            if (state === "background") wake.add(outcome);
          },
        },
        AbortSignal.any([ctx.signal, controller.signal]),
      );
      const settled = batch.done.then((outcomes) => {
        if (state === "background") wake.flush();
        else state = "inline";
        return outcomes;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const yielded = new Promise<"yielded">((resolve) => {
        if (notifyAs === undefined) return;
        timer = setTimeout(() => {
          if (state !== "waiting") return;
          state = "background";
          for (const { task, outcome } of batch.progress()) if (outcome) reported.set(task, outcome);
          resolve("yielded");
        }, yieldMs);
      });
      const stop = () => controller.abort();
      if (call.signal.aborted) stop();
      else call.signal.addEventListener("abort", stop, { once: true });

      const first = await Promise.race([settled, yielded]);
      clearTimeout(timer);
      call.signal.removeEventListener("abort", stop);
      if (first === "yielded") {
        await batch.opened;
        return backgrounded(batch, Date.now() - startedAt, reported);
      }

      const outcomes: Outcome[] = first;
      const sessions = outcomes.flatMap((o) =>
        o.session ? [{ sessionId: o.session.id, status: o.status }] : [],
      );
      return {
        content: [{ type: "text", text: outcomeText(outcomes) }],
        ...(outcomes.every((o) => o.status !== "complete") ? { isError: true } : {}),
        meta: { sessions, presented: outcomes.flatMap((o) => o.presented) },
      };
    },
  };
}
