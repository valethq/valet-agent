import type { PluginContext } from "@valethq/sdk";
import { type AgentConfig, isModelRef, type ModelRef } from "./model";

export interface SettingsPanel {
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  get(): Record<string, unknown> | Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): void | Promise<void>;
}

declare module "@valethq/sdk" {
  interface ValetScopes {
    settings: SettingsPanel;
  }
}

const QUEUE_MODES = ["queue", "interrupt"] as const;

/** Session agent.queueMode wins; this is the default when it is unset. */
export function defaultQueueMode(ctx: PluginContext<AgentConfig>): string {
  const v = ctx.storage.kv.get<string>("defaultQueueMode");
  return typeof v === "string" && (QUEUE_MODES as readonly string[]).includes(v) ? v : "queue";
}

/** The kv override for the default model, or undefined when the form is blank. */
function storedModel(ctx: PluginContext<AgentConfig>): ModelRef | undefined {
  const m = ctx.storage.kv.get<ModelRef>("defaultModel");
  return isModelRef(m) ? { provider: m.provider, model: m.model } : undefined;
}

export function registerSettings(ctx: PluginContext<AgentConfig>): void {
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.scopes.provide(
    "settings",
    {
      title: "Agent",
      description: "Defaults for sessions that don't set their own. Blank fields inherit config.json.",
      schema: {
        type: "object",
        properties: {
          defaultQueueMode: {
            type: "string",
            title: "Default queue mode",
            description: "queue: new messages wait for the active run. interrupt: cancel it and run now.",
            enum: QUEUE_MODES,
          },
          defaultProvider: { type: "string", title: "Default provider" },
          defaultModel: { type: "string", title: "Default model" },
        },
      },
      get: () => {
        const m = storedModel(ctx);
        return {
          defaultQueueMode: ctx.storage.kv.get<string>("defaultQueueMode") ?? "",
          defaultProvider: m?.provider ?? "",
          defaultModel: m?.model ?? "",
        };
      },
      set: (v) => {
        const q = v.defaultQueueMode;
        if (typeof q !== "string" || !(QUEUE_MODES as readonly string[]).includes(q))
          throw new Error(`defaultQueueMode must be one of: ${QUEUE_MODES.join(", ")}`);
        ctx.storage.kv.set("defaultQueueMode", q);
        const provider = typeof v.defaultProvider === "string" ? v.defaultProvider.trim() : "";
        const model = typeof v.defaultModel === "string" ? v.defaultModel.trim() : "";
        if (provider === "" && model === "") ctx.storage.kv.delete("defaultModel");
        else if (provider === "" || model === "")
          throw new Error("defaultProvider and defaultModel must be set together");
        else ctx.storage.kv.set("defaultModel", { provider, model });
      },
    },
    { key: "valet-agent" },
  );
}
