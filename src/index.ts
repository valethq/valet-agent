import { definePlugin, type ToolDefinition } from "@valethq/sdk";
import { AgentSessions } from "./agents";
import { Catalog } from "./catalog";
import { registerCommands } from "./commands";
import { isNotification, textOf } from "./content";
import { agentMeta } from "./copy";
import type { Env } from "./env";
import { registerHttp } from "./http";
import { ToolRouter } from "./surface";
import type { AgentConfig } from "./model";
import { presentTool } from "./present";
import { RunQueue } from "./queue";
import { registerSettings } from "./settings";
import { startFor } from "./subject";
import { subagentTool } from "./subagent";
import { SUBAGENT_END } from "./subagent-notify";
import { placeholderPatch } from "./title";
import { rewriteLegacyRefs } from "./legacy";

export default definePlugin<AgentConfig>({
  activate(ctx) {
    const ownTools = (): ToolDefinition[] => [
      presentTool(ctx) as ToolDefinition,
      subagentTool(ctx, queue, catalog) as ToolDefinition,
    ];
    ctx.store.partTypes.define(SUBAGENT_END);
    const tools = new ToolRouter(ctx, ownTools);
    const catalog = new Catalog(ctx);
    const env: Env = {
      ctx,
      agents: new AgentSessions(ctx, tools),
      catalog,
      tools,
      lastUsage: new Map(),
      ownTools,
    };
    const queue = new RunQueue(env);
    ctx.onDispose(() => env.agents.closeAll());
    ctx.onConfigChange(() => {}); // config is read from ctx.config at use, so a reload needs no action

    registerCommands(env, queue);
    registerHttp(env, queue);
    registerSettings(ctx, catalog, ownTools);

    ctx.events.after("message.create", (e) => {
      const { message, parts } = e.payload;
      const notification = isNotification(ctx.store, message, parts);
      if (e.cancelled || (message.role !== "user" && !notification) || message.status !== "complete") return;
      const meta = agentMeta(message);
      if (meta.copiedFrom) return; // forks and moves copy history; they never rerun it
      const session = ctx.store.sessions.get(message.sessionId);
      if (!notification && session?.title === null) {
        const patch = placeholderPatch(session, textOf(parts));
        if (patch) void ctx.store.sessions.update(session.id, patch).catch(() => {});
      }
      const start = startFor(ctx.store, message, e.caller, notification || meta.parentRunId !== undefined);
      if ("refused" in start) {
        ctx.log.warn("derived run refused", { sessionId: message.sessionId, reason: start.refused });
        queue.refuse(message.sessionId, message.id);
        return;
      }
      queue.enqueue({ sessionId: message.sessionId, message, parts, ...start });
    });

    ctx.events.after("run.cancel", (e) => {
      if (!e.cancelled) queue.abort(e.payload.runId);
    });

    ctx.events.after("session.delete", (e) => {
      if (e.cancelled) return;
      queue.dropSession(e.payload.session.id);
      env.tools.forget(e.payload.session.id);
      void env.agents.drop(e.payload.session.id);
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
      await catalog.warm();
      await rewriteLegacyRefs(ctx, catalog);
      for (const project of ctx.store.projects.list()) {
        for (const s of ctx.store.sessions.list({ projectId: project.id })) {
          if (s.status === "running")
            await ctx.store.sessions.update(s.id, { status: "idle" }).catch(() => {});
          if (s.title !== null) continue;
          try {
            const first = ctx.store.messages.list(s.id).find(({ message }) => message.role === "user");
            const patch = first ? placeholderPatch(s, textOf(first.parts)) : null;
            if (patch) await ctx.store.sessions.update(s.id, patch);
          } catch {}
        }
      }
    })().catch(() => {});
  },
});
