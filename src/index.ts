import { definePlugin } from "@valethq/sdk";
import "./context-types";
import { AgentSessions } from "./agents";
import { registerCommands } from "./commands";
import type { Env } from "./env";
import { registerHttp } from "./http";
import type { AgentConfig } from "./model";
import { RunQueue } from "./queue";
import { authorRole } from "./role";

export default definePlugin<AgentConfig>({
  activate(ctx) {
    const env: Env = { ctx, agents: new AgentSessions(ctx), lastUsage: new Map() };
    const queue = new RunQueue(env);
    ctx.onDispose(() => env.agents.closeAll());

    registerCommands(env, queue);
    registerHttp(env, queue);

    ctx.events.after("message.create", (e) => {
      const { message, parts } = e.payload;
      if (e.cancelled || message.role !== "user" || message.status !== "complete") return;
      const role = authorRole(ctx.store, message.authorPrincipalId, e.caller);
      queue.enqueue({ sessionId: message.sessionId, message, parts, role });
    });

    ctx.events.after("run.cancel", (e) => {
      if (!e.cancelled) queue.abort(e.payload.runId);
    });

    ctx.events.after("run.interrupted", async ({ payload: { run } }) => {
      if (ctx.store.runs.get(run.id)?.status === "running")
        ctx.store.runs.update(run.id, { status: "interrupted" });
      for (const { message } of ctx.store.messages.list(run.sessionId, { limit: 50 })) {
        if (message.runId === run.id && message.status === "streaming") {
          await ctx.store.messages.complete(message.id, "interrupted");
        }
      }
    });
  },
});
