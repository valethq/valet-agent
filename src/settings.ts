import type { Option, PluginContext, ToolDefinition } from "@valethq/sdk";
import type { Catalog } from "./catalog";
import type { AgentConfig } from "./model";

/** settings@2 option sources for the settings doc: providers, their models and efforts, and tool names. */
export function registerSettings(
  ctx: PluginContext<AgentConfig>,
  catalog: Catalog,
  ownTools: () => ToolDefinition[],
): void {
  ctx.scopes.define({ name: "settings", version: 2, cardinality: "many" });
  ctx.scopes.provide("settings", {
    options: {
      providers: async (): Promise<Option[]> =>
        (await catalog.providers()).map((p) => ({
          value: p.provider,
          label: p.label,
          ...(p.icon && { icon: p.icon }),
        })),
      models: async ({ provider }): Promise<Option[]> =>
        ((await catalog.providers()).find((p) => p.provider === provider)?.models ?? [])
          .filter((m) => m.show)
          .map((m) => ({ value: m.id, label: m.name })),
      efforts: async ({ provider, model }): Promise<Option[]> => {
        if (typeof provider !== "string" || typeof model !== "string") return [];
        return ((await catalog.info({ provider, model })).efforts ?? []).map((e) => ({ value: e }));
      },
      tools: async (): Promise<Option[]> => {
        const names = new Set(ownTools().map((t) => t.name));
        for (const { impl } of ctx.scopes.all("tools")) {
          try {
            for (const t of await impl.list({ sessionId: "", projectId: "", role: "owner" }))
              names.add(t.name);
          } catch {
            // A provider that needs a real session lists nothing here; any name can still be typed.
          }
        }
        return [...names].sort().map((value) => ({ value }));
      },
    },
  });
}
