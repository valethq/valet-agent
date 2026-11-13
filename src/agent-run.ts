import type { AgentProvider, ModelInfo } from "@valethq/sdk";
import { CompactionRecorder, compactionNote, harnessCompactions } from "./compactions";
import type { Env } from "./env";
import type { ModelRef } from "./model";
import type { Outcome, RunCtx } from "./run-types";

export async function runAgent(
  env: Env,
  provider: AgentProvider,
  cand: ModelRef,
  rc: RunCtx,
  info: ModelInfo,
): Promise<Outcome> {
  const { ctx } = env;
  const entry = await env.agents.acquire(provider, rc.sessionId, rc.cwd, cand.model);
  const preamble = entry.needsPreamble
    ? await ctx.scopes.get("context").preamble({
        sessionId: rc.sessionId,
        role: rc.role,
        model: { id: info.id, contextWindow: info.contextWindow || undefined },
      })
    : undefined;
  const compactions = harnessCompactions(rc.store, rc.sessionId);
  const note = compactions.length > entry.notedCompactions;
  const content = note ? [compactionNote(compactions), ...rc.content] : rc.content;
  if (note) entry.notedCompactions = compactions.length;
  const input = { content, ...(preamble ? { preamble } : {}) };
  const recorder = new CompactionRecorder(ctx, rc.sessionId, provider.label);
  for await (const ev of entry.session.prompt(input, rc.signal)) {
    entry.needsPreamble = false;
    switch (ev.type) {
      case "text-delta":
      case "reasoning-delta":
        rc.parts.text(ev.type === "text-delta" ? "text" : "reasoning", ev.text);
        break;
      case "tool-start":
        rc.parts.start({ ...ev, status: "running" });
        break;
      case "tool-update":
        rc.parts.update(ev.callId, { outputDelta: ev.outputDelta, status: ev.status });
        break;
      case "tool-end":
        rc.parts.end(ev.callId, ev.status, {
          output: ev.output,
          ...(typeof ev.exitCode === "number"
            ? {
                result: {
                  content: [],
                  isError: ev.status === "error",
                  meta: { exitCode: ev.exitCode },
                },
              }
            : {}),
        });
        break;
      case "permission": {
        const { callId, title } = ev.request;
        const gate = await ctx.events.emit("tool.call", {
          runId: rc.runId,
          callId,
          name: title,
          input: { title },
          role: rc.role,
        });
        ev.respond(!gate.cancelled);
        if (gate.cancelled) rc.parts.update(callId, { status: "denied" });
        break;
      }
      case "usage":
        rc.usage(ev);
        break;
      case "notice":
        rc.parts.notice(ev.level === "warning" ? "warn" : ev.level, ev.text);
        break;
      case "compaction-start":
        // the harness compacts its own context; valet only marks it in the chat
        await recorder.start();
        break;
      case "compaction-end":
        await recorder.end(ev.status, ev.error);
        break;
      case "finish":
        await recorder.end(
          ev.reason === "cancelled" ? "cancelled" : "failed",
          "the turn ended before the compaction finished",
        );
        if (ev.reason === "error") return { status: "error", error: ev.error ?? "agent error" };
        return ev.reason === "cancelled" ? { status: "cancelled" } : { status: "stop" };
    }
  }
  await recorder.end(
    rc.signal.aborted ? "cancelled" : "failed",
    "the turn ended before the compaction finished",
  );
  return rc.signal.aborted ? { status: "cancelled" } : { status: "stop" };
}
