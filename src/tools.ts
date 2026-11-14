import type { Role, ToolDefinition } from "@valethq/sdk";
import type { AgentCtx } from "./env";
import { presentTool } from "./present";
import { roleAtLeast } from "./role";

/** Every tools@1 provider's tools for one scope, then valet-agent's own; the first to claim a name wins. */
export async function listTools(
  ctx: AgentCtx,
  scope: { sessionId: string; projectId: string; role: Role },
): Promise<Map<string, ToolDefinition>> {
  const defs = new Map<string, ToolDefinition>();
  for (const provider of ctx.scopes.all("tools")) {
    for (const def of await provider.impl.list(scope)) if (!defs.has(def.name)) defs.set(def.name, def);
  }
  for (const def of [presentTool(ctx) as ToolDefinition]) {
    if (!defs.has(def.name) && roleAtLeast(scope.role, def.minRole ?? "owner")) defs.set(def.name, def);
  }
  return defs;
}
