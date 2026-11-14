import type { Part, Session, SessionSettings, Store, ToolDefinition, ToolResult } from "@valethq/sdk";
import type { AgentCtx } from "./env";
import { configFor, type ModelRef, resolveModel } from "./model";
import type { Presented } from "./present";
import type { RunQueue } from "./queue";
import { roleAtLeast } from "./role";

const MAX_DEPTH = 3;

interface Input {
  prompt?: unknown;
  session?: unknown;
  title?: unknown;
  model?: unknown;
}

const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function depthOf(store: Store, session: Session): number {
  let depth = 0;
  for (let s: Session | undefined = session; s?.parentSessionId && depth <= MAX_DEPTH; depth++)
    s = store.sessions.get(s.parentSessionId);
  return depth;
}

/** The child's settings: the parent's model and queue mode, nothing it recorded about its own history. */
function childSettings(parent: SessionSettings, model: ModelRef | undefined): SessionSettings {
  const { titlePlaceholder: _t, agent, model: parentModel, ...rest } = structuredClone(parent);
  const queueMode = (agent as { queueMode?: unknown } | undefined)?.queueMode;
  const chosen = model ?? parentModel;
  return {
    ...rest,
    ...(chosen ? { model: chosen } : {}),
    ...(typeof queueMode === "string" ? { agent: { queueMode } } : {}),
  };
}

function replyOf(store: Store, sessionId: string, runId: string | undefined): ToolResult {
  const run = runId ? store.runs.get(runId) : undefined;
  const parts: Part[] = store.messages
    .list(sessionId, { limit: 50 })
    .filter(({ message }) => runId !== undefined && message.role === "assistant" && message.runId === runId)
    .flatMap((e) => e.parts);
  const text = parts
    .flatMap(({ data }) => (data.type === "text" ? [data.text] : []))
    .join("\n")
    .trim();
  const presented: Presented[] = parts.flatMap(({ data }) =>
    data.type === "file" ? [{ blobId: data.blobId, name: data.name, mime: data.mime }] : [],
  );
  const footer = `[subagent session ${sessionId}; pass it as "session" to continue this subagent]`;
  const meta = { sessionId, ...(runId ? { runId } : {}) };
  if (run?.status !== "complete") {
    const why = run ? `${run.status}${run.error ? `: ${run.error}` : ""}` : "never ran";
    return {
      content: [{ type: "text", text: `${text}\n\nThe subagent run ${why}.\n${footer}`.trim() }],
      isError: true,
      meta,
    };
  }
  return {
    content: [{ type: "text", text: `${text || "(no reply)"}\n\n${footer}` }],
    meta: { ...meta, presented },
  };
}

/** Starts or continues a child session (parentSessionId = this chat), runs one turn there with this run's role, and returns its reply. */
export function subagentTool(ctx: AgentCtx, queue: RunQueue): ToolDefinition<Input> {
  return {
    name: "subagent",
    description:
      "Hand a self-contained task to a subagent: a child session of this chat with its own context and the same tools. " +
      "It waits for the subagent's turn and returns its final reply plus its session id. " +
      "Pass that id as `session` to send the same subagent a follow-up; omit it to start a fresh one. " +
      "The subagent can't see this chat, so put everything it needs in `prompt`.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task, with all the context the subagent needs." },
        session: {
          type: "string",
          description: "A subagent session id from an earlier call, to continue it.",
        },
        title: { type: "string", description: "Short title for a new subagent session." },
        model: {
          type: "string",
          description: 'Model for a new subagent, "model" or "provider:model". Defaults to this chat\'s.',
        },
      },
      required: ["prompt"],
    },
    async invoke(input, call) {
      if (!roleAtLeast(call.role, "owner")) return failure("subagent is not available to this role");
      if (typeof input.prompt !== "string" || input.prompt.trim() === "")
        return failure("prompt is required");
      const parent = ctx.store.sessions.get(call.sessionId);
      if (!parent) return failure("unknown session");
      const author = call.caller.actor?.principalId;
      const store =
        author && ctx.store.principals.get(author) ? ctx.store.as({ principalId: author }) : ctx.store;

      let child: Session;
      if (typeof input.session === "string" && input.session !== "") {
        const found = ctx.store.sessions.get(input.session);
        if (found?.parentSessionId !== parent.id)
          return failure(`${input.session} is not a subagent of this chat`);
        child = found;
      } else {
        if (depthOf(ctx.store, parent) >= MAX_DEPTH)
          return failure(`subagents nest at most ${MAX_DEPTH} deep`);
        let model: ModelRef | undefined;
        if (typeof input.model === "string" && input.model.trim() !== "") {
          const arg = input.model.trim();
          const sep = arg.indexOf(":");
          const explicit = sep > 0 && ctx.scopes.maybe("inference", arg.slice(0, sep)) !== undefined;
          const current = resolveModel(parent, ctx.store.projects.get(parent.projectId), configFor(ctx));
          model = explicit
            ? { provider: arg.slice(0, sep), model: arg.slice(sep + 1) }
            : { provider: current.provider, model: arg };
        }
        const created = await store.sessions.create({
          projectId: parent.projectId,
          parentSessionId: parent.id,
          ...(typeof input.title === "string" && input.title.trim() !== ""
            ? { title: input.title.trim() }
            : {}),
          settings: childSettings(parent.settings, model),
        });
        if ("cancelled" in created)
          return failure(`could not start a subagent: ${created.cancelReason ?? "cancelled"}`);
        child = created;
      }

      const finished = new Map<string, string | undefined>();
      let wake = () => {};
      const off = queue.onFinished((f) => {
        if (f.sessionId !== child.id) return;
        finished.set(f.messageId, f.runId);
        wake();
      });
      try {
        const sent = await store.messages.create({
          sessionId: child.id,
          role: "user",
          ...(author ? { authorPrincipalId: author } : {}),
          meta: { agent: { parentRunId: call.runId } },
          parts: [{ type: "text", text: input.prompt }],
        });
        if ("cancelled" in sent)
          return failure(`the subagent prompt was refused: ${sent.cancelReason ?? "cancelled"}`);
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
          return failure(`cancelled; the subagent session is ${child.id}`);
        }
        return replyOf(ctx.store, child.id, finished.get(id));
      } finally {
        off();
      }
    },
  };
}
