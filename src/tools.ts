import { allowedTools, type Caller, type Role, type ToolDefinition } from "@valethq/sdk";
import type { AgentCtx } from "./env";
import type { RunCtx } from "./run-types";

/** Every tools@1 provider's tools for one scope, then valet-agent's own (`own`); the first to claim a name wins. */
export async function listTools(
  ctx: AgentCtx,
  scope: { sessionId: string; projectId: string; role: Role; caller: Caller },
  own: ToolDefinition[],
): Promise<Map<string, ToolDefinition>> {
  const defs = new Map<string, ToolDefinition>();
  for (const provider of ctx.scopes.all("tools")) {
    for (const def of await provider.impl.list(scope)) if (!defs.has(def.name)) defs.set(def.name, def);
  }
  for (const def of allowedTools(ctx, scope, own)) if (!defs.has(def.name)) defs.set(def.name, def);
  return defs;
}

/** The `tool.call` gate, stamped with the run's subject when the run has a principal. */
export function emitToolCall(
  ctx: AgentCtx,
  rc: RunCtx,
  call: { callId: string; name: string; input: unknown },
) {
  const principalId = rc.caller.actor?.principalId;
  return ctx.events.emit(
    "tool.call",
    { callId: call.callId, name: call.name, input: call.input, runId: rc.runId, role: rc.role },
    principalId ? { as: { principalId, runId: rc.runId } } : undefined,
  );
}
