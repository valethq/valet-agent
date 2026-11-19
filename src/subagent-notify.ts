import type { PartTypeDefinition } from "@valethq/sdk";
import type { AgentCtx } from "./env";
import { type Outcome, oneLine, outcomeText, titleOf } from "./subagent-text";

/** Longest reply the notification carries per subagent; the rest stays in the child's session. */
export const MAX_REPLY_CHARS = 8_000;

/** The part a subagent-batch-end notification holds (ARCHITECTURE 9.4). People see the title; the model sees the text. */
export const SUBAGENT_END: PartTypeDefinition = {
  id: "valet-agent/subagent-end@1",
  description:
    "Subagents that were running in the background have ended. The text is each one's status and reply.",
  schema: {
    type: "object",
    required: ["durationMs", "subagents"],
    properties: {
      durationMs: { type: "number" },
      subagents: {
        type: "array",
        items: {
          type: "object",
          required: ["sessionId", "title", "status"],
          properties: {
            sessionId: { type: "string" },
            title: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    },
  },
  view: { collapsed: true, icon: "bot", fields: ["durationMs"] },
  wakes: true,
};

export function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Tells the parent chat that background subagents ended: a system message holding a `valet-agent/subagent-end@1`
 * part, whose type wakes the session. `remaining` is how many of the call's subagents are still to end. Written as
 * the principal behind the call, whose role the wake-up run takes. Stays quiet when valet is stopping or the chat
 * is gone.
 */
export async function announce(
  ctx: AgentCtx,
  n: { sessionId: string; principalId: string; outcomes: Outcome[]; remaining: number; startedAt: number },
): Promise<void> {
  if (ctx.signal.aborted || !ctx.store.sessions.get(n.sessionId)) return;
  const { outcomes } = n;
  const ok = outcomes.filter((o) => o.status === "complete").length;
  const took = elapsed(Date.now() - n.startedAt);
  const noun = `subagent${outcomes.length === 1 ? "" : "s"}`;
  const counts = ok === outcomes.length ? "all complete" : `${ok} of ${outcomes.length} complete`;
  const left =
    n.remaining > 0
      ? `${n.remaining} still running; you will be notified when they end`
      : "none are left running";
  const text = `[valet-agent] ${outcomes.length} background ${noun} ended after ${took} (${counts}); ${left}.\n\n${outcomeText(outcomes, MAX_REPLY_CHARS)}`;
  const names = outcomes.map(titleOf).join(", ");
  try {
    const sent = await ctx.store.as({ principalId: n.principalId }).messages.create({
      sessionId: n.sessionId,
      role: "system",
      authorPrincipalId: n.principalId,
      parts: [
        {
          type: "custom",
          kind: SUBAGENT_END.id,
          title: `Subagents ${ok === outcomes.length ? "finished" : "ended"}: ${oneLine(names).slice(0, 80)}`,
          text,
          data: {
            durationMs: Date.now() - n.startedAt,
            subagents: outcomes.flatMap((o) =>
              o.session ? [{ sessionId: o.session.id, title: titleOf(o), status: o.status }] : [],
            ),
          },
        },
      ],
    });
    if ("cancelled" in sent)
      ctx.log.warn("subagent notification refused", {
        sessionId: n.sessionId,
        reason: sent.cancelReason ?? "cancelled",
      });
  } catch (error) {
    ctx.log.warn("subagent notification failed", { sessionId: n.sessionId, error: String(error) });
  }
}
