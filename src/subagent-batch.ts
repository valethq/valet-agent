import type { Session, SessionSettings } from "@valethq/sdk";
import type { Catalog } from "./catalog";
import type { AgentCtx } from "./env";
import { type ModelRef, parseRef, resolveModel } from "./model";
import type { RunQueue } from "./queue";
import { type Outcome, replyOf, type Task } from "./subagent-text";

export interface BatchInit {
  ctx: AgentCtx;
  queue: RunQueue;
  catalog: Catalog;
  parent: Session;
  /** The run whose subagent call started the batch. */
  runId: string;
  /** The principal behind the call; the children's prompts are written as them. */
  author?: string;
  tasks: Task[];
  /** Called as each task ends, in the order they end, before `done` settles. Must not throw. */
  onEnded?: (outcome: Outcome) => void;
}

export interface TaskState {
  task: Task;
  /** Set once the task's child session exists. */
  session?: Session;
  /** Set once the task has ended. */
  outcome?: Outcome;
}

export interface Batch {
  /** Settles with every task's outcome, in stage order, once every stage has ended. Never rejects. */
  done: Promise<Outcome[]>;
  /** Settles once the first stage's children exist, or could not be opened. */
  opened: Promise<void>;
  progress(): TaskState[];
  /** How many tasks have not ended yet, including those in stages that have not started. */
  remaining(): number;
}

/** The child's settings: the parent's model, plus which run and stage started it (the UI groups children by run). */
function childSettings(
  parent: SessionSettings,
  model: ModelRef | undefined,
  runId: string,
  stage: number,
): SessionSettings {
  const { titlePlaceholder: _t, agent: _a, model: parentModel, ...rest } = structuredClone(parent);
  const chosen = model ?? parentModel;
  return {
    ...rest,
    ...(chosen ? { model: chosen } : {}),
    agent: { parentRunId: runId, stage },
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Starts or continues one child session per task and runs a turn in each: tasks in the same stage at once, stages
 * in ascending order. The work follows `signal`, not the call that started it: aborting it cancels every child
 * that is running or queued.
 */
export function startBatch(init: BatchInit, signal: AbortSignal): Batch {
  const { ctx, queue, catalog, parent, runId, author, tasks } = init;
  const store =
    author && ctx.store.principals.get(author) ? ctx.store.as({ principalId: author }) : ctx.store;
  const current = resolveModel(parent, ctx.store.projects.get(parent.projectId), ctx.config);
  const sessions = new Map<Task, Session>();
  const outcomes = new Map<Task, Outcome>();

  const modelOf = (task: Task): ModelRef | undefined => {
    if (task.model === undefined) return undefined;
    const ref = parseRef(task.model, current, (key) => ctx.scopes.maybe("inference", key) !== undefined);
    return ref && catalog.normalize(ref);
  };

  const open = async (task: Task): Promise<Session | string> => {
    if (task.session !== undefined) return ctx.store.sessions.get(task.session) as Session;
    try {
      const created = await store.sessions.create({
        projectId: parent.projectId,
        parentSessionId: parent.id,
        ...(task.title ? { title: task.title } : {}),
        settings: childSettings(parent.settings, modelOf(task), runId, task.stage),
      });
      return "cancelled" in created
        ? `could not start a subagent: ${created.cancelReason ?? "cancelled"}`
        : created;
    } catch (error) {
      return `could not start a subagent: ${errorText(error)}`;
    }
  };

  /** Posts the task's prompt to its child and waits for that turn to end. */
  const turn = async (task: Task, child: Session): Promise<Outcome> => {
    const finished = new Map<string, string | undefined>();
    let wake = () => {};
    const off = queue.onFinished((f) => {
      if (f.sessionId !== child.id) return;
      finished.set(f.messageId, f.runId);
      wake();
    });
    const stopped = (status: string, error?: string): Outcome => ({
      task,
      session: child,
      status,
      reply: "",
      presented: [],
      ...(error ? { error } : {}),
    });
    let onAbort: (() => void) | undefined;
    try {
      const sent = await store.messages.create({
        sessionId: child.id,
        role: "user",
        ...(author ? { authorPrincipalId: author } : {}),
        meta: { agent: { parentRunId: runId } },
        parts: [{ type: "text", text: task.prompt }],
      });
      if ("cancelled" in sent) return stopped("refused", sent.cancelReason ?? "cancelled");
      const id = sent.message.id;
      const aborted = await new Promise<boolean>((resolve) => {
        wake = () => {
          if (finished.has(id)) resolve(false);
        };
        onAbort = () => resolve(true);
        wake();
        if (signal.aborted) resolve(true);
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      if (aborted) {
        if (queue.activeMessageId(child.id) === id) await queue.cancelActive(child.id, ctx.plugin.id);
        else queue.dropJob(child.id, id);
        return stopped("cancelled");
      }
      return { task, session: child, ...replyOf(ctx.store, child.id, finished.get(id)) };
    } catch (error) {
      return stopped("error", errorText(error));
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      off();
    }
  };

  let markOpened = () => {};
  const opened = new Promise<void>((resolve) => {
    markOpened = resolve;
  });

  const run = async (): Promise<Outcome[]> => {
    const ended: Outcome[] = [];
    try {
      for (const stage of [...new Set(tasks.map((t) => t.stage))].sort((a, b) => a - b)) {
        if (signal.aborted) break;
        const batch = tasks.filter((t) => t.stage === stage);
        // children are created one by one so their order matches the task order, then every turn starts together
        const children: (Session | string)[] = [];
        for (const task of batch) {
          const child = await open(task);
          children.push(child);
          if (typeof child !== "string") sessions.set(task, child);
        }
        markOpened();
        ended.push(
          ...(await Promise.all(
            batch.map(async (task, i): Promise<Outcome> => {
              const child = children[i] as Session | string;
              const outcome: Outcome =
                typeof child === "string"
                  ? { task, status: "refused", error: child, reply: "", presented: [] }
                  : await turn(task, child);
              outcomes.set(task, outcome);
              init.onEnded?.(outcome);
              return outcome;
            }),
          )),
        );
      }
    } catch (error) {
      ctx.log.error("subagent batch failed", { sessionId: parent.id, error: errorText(error) });
      for (const task of tasks) {
        if (!outcomes.has(task)) {
          const outcome: Outcome = {
            task,
            ...(sessions.has(task) ? { session: sessions.get(task) as Session } : {}),
            status: "error",
            error: errorText(error),
            reply: "",
            presented: [],
          };
          outcomes.set(task, outcome);
          ended.push(outcome);
          init.onEnded?.(outcome);
        }
      }
    } finally {
      markOpened();
    }
    const unstarted = tasks.filter((t) => !outcomes.has(t));
    return [
      ...ended,
      ...unstarted.map((task): Outcome => ({ task, status: "not started", reply: "", presented: [] })),
    ];
  };

  return {
    done: run(),
    opened,
    remaining: () => tasks.filter((t) => !outcomes.has(t)).length,
    progress: () =>
      tasks.map((task) => {
        const session = sessions.get(task);
        const outcome = outcomes.get(task);
        return { task, ...(session ? { session } : {}), ...(outcome ? { outcome } : {}) };
      }),
  };
}
