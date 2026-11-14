import type { Role, ScopeRegistry, ToolDefinition } from "@valethq/sdk";

/** Every tools@1 provider's tools for one scope; the first provider to claim a name wins. */
export async function listTools(
  scopes: ScopeRegistry,
  scope: { sessionId: string; projectId: string; role: Role },
): Promise<Map<string, ToolDefinition>> {
  const defs = new Map<string, ToolDefinition>();
  for (const provider of scopes.all("tools")) {
    for (const def of await provider.impl.list(scope)) if (!defs.has(def.name)) defs.set(def.name, def);
  }
  return defs;
}
