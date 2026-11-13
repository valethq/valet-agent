import type { Caller, Part } from "@valethq/sdk";
import type { Env } from "./env";
import { resolveModel } from "./model";
import type { RunQueue } from "./queue";
import { authorRole } from "./role";

interface CommandCtx {
  env: Env;
  queue: RunQueue;
  sessionId: string;
  arg: string;
  caller: Caller;
}
type Command = (c: CommandCtx) => Promise<string>;

const isCancelled = (r: object): r is { cancelled: true; cancelReason?: string } => "cancelled" in r;

const COMMANDS: Record<string, Command> = {
  async model({ env, sessionId, arg }) {
    const { store } = env.ctx;
    const session = store.sessions.get(sessionId);
    if (!session) return "Unknown session.";
    const current = resolveModel(session, store.projects.get(session.projectId), env.ctx.config);
    if (!arg) return `Current model: ${current.provider}:${current.model}.`;
    const sep = arg.indexOf(":");
    const explicit = sep > 0 && env.ctx.scopes.maybe("inference", arg.slice(0, sep)) !== undefined;
    const ref = explicit
      ? { provider: arg.slice(0, sep), model: arg.slice(sep + 1) }
      : { provider: current.provider, model: arg };
    const fallbacks = session.settings.model?.fallbacks;
    const res = await store.sessions.update(sessionId, {
      settings: { ...session.settings, model: { ...ref, ...(fallbacks ? { fallbacks } : {}) } },
    });
    return isCancelled(res)
      ? `Could not change model: ${res.cancelReason ?? "cancelled"}.`
      : `Model set to ${ref.model}.`;
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
  async compact({ env, sessionId }) {
    try {
      await env.ctx.scopes.get("context").compact({ sessionId, reason: "manual" });
      return "Compacted.";
    } catch (error) {
      return `Compaction failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

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
      const match = message.role === "user" ? /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(firstText(parts)) : null;
      const command = match && COMMANDS[(match[1] as string).toLowerCase()];
      if (!command || authorRole(ctx.store, message.authorPrincipalId, e.caller) !== "owner") return;
      try {
        replies.set(
          message.id,
          await command({
            env,
            queue,
            sessionId: message.sessionId,
            arg: (match[2] ?? "").trim(),
            caller: e.caller,
          }),
        );
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
    await ctx.store.messages.create({
      sessionId,
      role: "assistant",
      origin: { platform: "system", conversationId: sessionId },
      parts: [{ type: "text", text }],
    });
  });
}
