import { AgentOperationError, type Caller, can, type Part, sessionResource } from "@valethq/sdk";
import { compactSession } from "./compact";
import type { Env } from "./env";
import { forkSession } from "./fork";
import { modelLabel } from "./labels";
import { parseRef, resolveModel } from "./model";
import { moveDenied, moveSession } from "./move";
import type { RunQueue } from "./queue";

interface CommandCtx {
  env: Env;
  queue: RunQueue;
  sessionId: string;
  arg: string;
  caller: Caller;
}
/** A reply is the command's text node; undefined means the command posts nothing (its work shows in the chat itself). */
type Command = (c: CommandCtx) => Promise<string | undefined>;

const isCancelled = (r: object): r is { cancelled: true; cancelReason?: string } => "cancelled" in r;

const COMMANDS: Record<string, Command> = {
  async model({ env, sessionId, arg }) {
    const { store } = env.ctx;
    const session = store.sessions.get(sessionId);
    if (!session) return "Unknown session.";
    const current = env.catalog.normalize(
      resolveModel(session, store.projects.get(session.projectId), env.ctx.config),
    );
    if (!arg) return `Current model: ${modelLabel(current)}.`;
    const parsed = parseRef(arg, current, (key) => env.ctx.scopes.maybe("inference", key) !== undefined);
    if (!parsed) return "Usage: /model [provider:]model [effort] [fast]";
    const ref = env.catalog.normalize(parsed);
    const fallbacks = session.settings.model?.fallbacks;
    const res = await store.sessions.update(sessionId, {
      settings: { ...session.settings, model: { ...ref, ...(fallbacks ? { fallbacks } : {}) } },
    });
    return isCancelled(res)
      ? `Could not change model: ${res.cancelReason ?? "cancelled"}.`
      : `Model set to ${modelLabel(ref)}.`;
  },
  async stop({ queue, sessionId, caller }) {
    const stopped = await queue.cancelActive(sessionId, caller.actor?.principalId ?? caller.plugin);
    return stopped ? "Stopped the active run." : "No active run.";
  },
  async new({ env, sessionId }) {
    const { store } = env.ctx;
    const session = store.sessions.get(sessionId);
    if (!session) return "Unknown session.";
    const res = await store.sessions.create({
      projectId: session.projectId,
      settings: structuredClone(session.settings),
    });
    return isCancelled(res)
      ? `Could not create a session: ${res.cancelReason ?? "cancelled"}.`
      : `New session: ${res.id}`;
  },
  async fork({ env, sessionId, arg, caller }) {
    const forked = await forkSession(storeFor(env, caller), sessionId, arg === "" ? undefined : arg);
    return `Forked: ${forked.id}`;
  },
  async move({ env, queue, sessionId, arg, caller }) {
    const { store } = env.ctx;
    if (arg === "") return "Usage: /move <project name or id>";
    const wanted = arg.toLowerCase();
    const matches = store.projects.list().filter((p) => p.id === arg || p.name.toLowerCase() === wanted);
    if (matches.length !== 1)
      return matches.length === 0
        ? `No project "${arg}".`
        : `More than one project is named "${arg}"; use its id.`;
    const project = matches[0] as { id: string; name: string };
    const source = store.sessions.get(sessionId);
    if (!source) return "Unknown session.";
    const denied = moveDenied(env.ctx, caller, store, source, project.id);
    if (denied) return `Move denied: ${denied.reason}`;
    const from = store.projects.get(source.projectId)?.name ?? "another project";
    const { activeRunId, queued } = queue.snapshot(sessionId);
    const moved = await moveSession(
      storeFor(env, caller),
      sessionId,
      project.id,
      activeRunId !== undefined || queued > 0,
    );
    // the original session is gone, so the reply goes to the moved one
    await postReply(env, moved.id, `Moved here from ${from}.`);
    return undefined;
  },
  async compact({ env, queue, sessionId, arg }) {
    if (!env.ctx.store.sessions.get(sessionId)) return "Unknown session.";
    // Compaction runs after this returns: the send must not wait on it, or the client times out and resends.
    void compactSession(env, queue, sessionId, arg === "" ? undefined : arg, "manual").then(
      ({ text }) => {
        if (text !== undefined) return postReply(env, sessionId, text);
      },
      (error: unknown) =>
        postReply(
          env,
          sessionId,
          error instanceof AgentOperationError
            ? error.message
            : `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
    return undefined;
  },
};

const storeFor = (env: Env, caller: Caller) => {
  const principalId = caller.actor?.principalId;
  return principalId && env.ctx.store.principals.get(principalId)
    ? env.ctx.store.as({ principalId })
    : env.ctx.store;
};

function postReply(env: Env, sessionId: string, text: string): Promise<unknown> {
  return env.ctx.store.messages.create({
    sessionId,
    role: "assistant",
    origin: { platform: "system", conversationId: sessionId },
    parts: [{ type: "text", text }],
  });
}

const firstText = (parts: Part[]): string => {
  const first = parts[0]?.data;
  return first?.type === "text" ? first.text.trim() : "";
};

export function registerCommands(env: Env, queue: RunQueue): void {
  const { ctx } = env;
  const replies = new Map<string, string>();

  ctx.events.before(
    "message.create",
    async (e) => {
      const { message, parts } = e.payload;
      // valet-agent's own writes (copies, subagent prompts) are never commands
      const own = e.caller.plugin === ctx.plugin.id;
      const match =
        message.role === "user" && !own ? /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(firstText(parts)) : null;
      const command = match && COMMANDS[(match[1] as string).toLowerCase()];
      if (!command || !can(ctx, e.caller, "agent:command", sessionResource(ctx, message.sessionId)).allow)
        return;
      try {
        const text = await command({
          env,
          queue,
          sessionId: message.sessionId,
          arg: (match[2] ?? "").trim(),
          caller: e.caller,
        });
        if (text !== undefined) replies.set(message.id, text);
      } catch (error) {
        replies.set(message.id, `Command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      e.cancel(`command /${match[1]}`);
    },
    { priority: 100 },
  );

  ctx.events.after("message.create", async (e) => {
    const text = replies.get(e.payload.message.id);
    if (text === undefined) return;
    replies.delete(e.payload.message.id);
    const { sessionId } = e.payload.message;
    await postReply(env, sessionId, text);
  });
}
