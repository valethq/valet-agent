import { definePlugin } from "@valethq/sdk";
import "./context-types";
import { AgentSessions } from "./agents";
import { registerCommands } from "./commands";
import { textOf } from "./content";
import type { Env } from "./env";
import { registerHttp } from "./http";
import type { AgentConfig } from "./model";
import { RunQueue } from "./queue";
import { authorRole } from "./role";
import { titleFrom } from "./title";

export default definePlugin<AgentConfig>({
  activate(ctx) {
    const env: Env = { ctx, agents: new AgentSessions(ctx), lastUsage: new Map() };
    const queue = new RunQueue(env);
    ctx.onDispose(() => env.agents.closeAll());
    ctx.onConfigChange(() => {}); // config is read from ctx.config at use, so a reload needs no action

    registerCommands(env, queue);
    registerHttp(env, queue);

    ctx.events.after("message.create", (e) => {
      const { message, parts } = e.payload;
      if (e.cancelled || message.role !== "user" || message.status !== "complete") return;
      const session = ctx.store.sessions.get(message.sessionId);
      if (session?.title === null) {
        const title = titleFrom(textOf(parts));
        if (title) void ctx.store.sessions.update(session.id, { title }).catch(() => {});
      }
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

    void (async () => {
      for (const project of ctx.store.projects.list()) {
        for (const s of ctx.store.sessions.list({ projectId: project.id })) {
          if (s.title !== null) continue;
          try {
            const first = ctx.store.messages
              .list(s.id, { limit: 20 })
              .find(({ message }) => message.role === "user");
            const title = first ? titleFrom(textOf(first.parts)) : null;
            if (title) await ctx.store.sessions.update(s.id, { title });
          } catch {}
        }
      }
    })().catch(() => {});
  },
});
