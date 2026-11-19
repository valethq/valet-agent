import type { Session, SessionSettings, Store, ToolDefinition, ToolResult } from "@valethq/sdk";
import type { AgentCtx } from "./env";
import type { Catalog } from "./catalog";
import { type ModelRef, parseRef, resolveModel } from "./model";
import type { Presented } from "./present";
import type { RunQueue } from "./queue";
import { roleAtLeast } from "./role";

const MAX_DEPTH = 3;
const MAX_TASKS = 8;
const MAX_STAGE = 99;

interface Task {
  index: number;
  prompt: string;
  stage: number;
  title?: string;
  session?: string;
  model?: string;
}

interface Outcome {
  task: Task;
  session?: Session;
  status: string;
  error?: string;
  reply: string;
  presented: Presented[];
}

const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
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

function depthOf(store: Store, session: Session): number {
  let depth = 0;
  for (let s: Session | undefined = session; s?.parentSessionId && depth <= MAX_DEPTH; depth++)
    s = store.sessions.get(s.parentSessionId);
  return depth;
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

function replyOf(store: Store, sessionId: string, runId: string | undefined) {
  const run = runId ? store.runs.get(runId) : undefined;
  const parts = store.messages
    .list(sessionId, { limit: 50 })
    .filter(({ message }) => runId !== undefined && message.role === "assistant" && message.runId === runId)
    .flatMap((e) => e.parts);
  const reply = parts
    .flatMap(({ data }) => (data.type === "text" ? [data.text] : []))
    .join("\n")
    .trim();
  const presented: Presented[] = parts.flatMap(({ data }) =>
    data.type === "file" ? [{ blobId: data.blobId, name: data.name, mime: data.mime }] : [],
  );
  return {
    reply,
    presented,
    status: run?.status ?? "never ran",
    ...(run?.error ? { error: run.error } : {}),
  };
}

const footer = (id: string): string =>
  `[subagent session ${id}; pass it as "session" to continue this subagent]`;

function outcomeText(outcomes: Outcome[]): string {
  return outcomes
    .map((o) => {
      const title = o.task.title ?? o.session?.title ?? oneLine(o.task.prompt).slice(0, 60);
      const head = outcomes.length > 1 ? `### ${title}\n` : "";
      const note =
        o.status === "complete" ? "" : `The subagent run ${o.status}${o.error ? `: ${o.error}` : ""}.\n`;
      const body = o.reply || (o.status === "complete" ? "(no reply)" : "");
      return [`${head}${note}${body}`.trim(), o.session ? footer(o.session.id) : ""]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
}

/**
 * Starts or continues child sessions (parentSessionId = this chat), runs one turn in each with this run's role,
 * and returns their replies. Tasks in the same stage run at once; stages run in ascending order.
 */
export function subagentTool(
  ctx: AgentCtx,
  queue: RunQueue,
  catalog: Catalog,
): ToolDefinition<{ tasks?: unknown }> {
  return {
    name: "subagent",
    description:
      "Hand self-contained tasks to subagents: child sessions of this chat, each with its own context and the same tools. " +
      "Pass every task in one call as `tasks`. By default they all run at once (in parallel). " +
      "Give tasks a `stage` number to order them: tasks sharing a stage run together, and stage 2 starts only after stage 1 has finished. " +
      "The call waits for every subagent and returns each one's final reply plus its session id; " +
      "pass that id as a task's `session` to send the same subagent a follow-up. " +
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
      },
      required: ["tasks"],
    },
    async invoke(input, call) {
      if (!roleAtLeast(call.role, "owner")) return failure("subagent is not available to this role");
      const tasks = parseTasks(input);
      if (typeof tasks === "string") return failure(tasks);
      const parent = ctx.store.sessions.get(call.sessionId);
      if (!parent) return failure("unknown session");
      for (const t of tasks) {
        if (t.session !== undefined && ctx.store.sessions.get(t.session)?.parentSessionId !== parent.id)
          return failure(`${t.session} is not a subagent of this chat`);
      }
      if (tasks.some((t) => t.session === undefined) && depthOf(ctx.store, parent) >= MAX_DEPTH)
        return failure(`subagents nest at most ${MAX_DEPTH} deep`);

      const author = call.caller.actor?.principalId;
      const store =
        author && ctx.store.principals.get(author) ? ctx.store.as({ principalId: author }) : ctx.store;
      const current = resolveModel(parent, ctx.store.projects.get(parent.projectId), ctx.config);

      const modelOf = (task: Task): ModelRef | undefined => {
        if (task.model === undefined) return undefined;
        const ref = parseRef(task.model, current, (key) => ctx.scopes.maybe("inference", key) !== undefined);
        return ref && catalog.normalize(ref);
      };

      const open = async (task: Task): Promise<Session | string> => {
        if (task.session !== undefined) return ctx.store.sessions.get(task.session) as Session;
        const created = await store.sessions.create({
          projectId: parent.projectId,
          parentSessionId: parent.id,
          ...(task.title ? { title: task.title } : {}),
          settings: childSettings(parent.settings, modelOf(task), call.runId, task.stage),
        });
        return "cancelled" in created
          ? `could not start a subagent: ${created.cancelReason ?? "cancelled"}`
          : created;
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
        try {
          const sent = await store.messages.create({
            sessionId: child.id,
            role: "user",
            ...(author ? { authorPrincipalId: author } : {}),
            meta: { agent: { parentRunId: call.runId } },
            parts: [{ type: "text", text: task.prompt }],
          });
          if ("cancelled" in sent) return stopped("refused", sent.cancelReason ?? "cancelled");
          const id = sent.message.id;
          const aborted = await new Promise<boolean>((resolve) => {
            wake = () => {
              if (finished.has(id)) resolve(false);
            };
            wake();
            if (call.signal.aborted) resolve(true);
            call.signal.addEventListener("abort", () => resolve(true), { once: true });
          });
          if (aborted) {
            await queue.cancelActive(child.id, ctx.plugin.id);
            queue.dropSession(child.id);
            return stopped("cancelled");
          }
          return { task, session: child, ...replyOf(ctx.store, child.id, finished.get(id)) };
        } finally {
          off();
        }
      };

      const outcomes: Outcome[] = [];
      for (const stage of [...new Set(tasks.map((t) => t.stage))].sort((a, b) => a - b)) {
        if (call.signal.aborted) break;
        const batch = tasks.filter((t) => t.stage === stage);
        // children are created one by one so their order matches the task order, then every turn starts together
        const opened: (Session | string)[] = [];
        for (const task of batch) opened.push(await open(task));
        outcomes.push(
          ...(await Promise.all(
            batch.map(async (task, i): Promise<Outcome> => {
              const child = opened[i] as Session | string;
              return typeof child === "string"
                ? { task, status: "refused", error: child, reply: "", presented: [] }
                : turn(task, child);
            }),
          )),
        );
      }

      const unstarted = tasks.filter((t) => !outcomes.some((o) => o.task === t));
      for (const task of unstarted) outcomes.push({ task, status: "not started", reply: "", presented: [] });
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
