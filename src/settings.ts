import type { PluginContext } from "@valethq/sdk";
import { type AgentConfig, isModelRef, type ModelRef } from "./model";

const QUEUE_MODES = ["queue", "interrupt"] as const;

/** Session agent.queueMode wins; this is the default when it is unset. */
export function defaultQueueMode(ctx: PluginContext<AgentConfig>): string {
  const v = ctx.storage.kv.get<string>("defaultQueueMode");
  return typeof v === "string" && (QUEUE_MODES as readonly string[]).includes(v) ? v : "queue";
}

/** Whether present is limited to the workspace and presentRoots. The panel's value wins over config.json; on by default. */
export function presentConfined(ctx: PluginContext<AgentConfig>): boolean {
  const v = ctx.storage.kv.get<boolean>("presentConfine");
  return typeof v === "boolean" ? v : (ctx.config.presentConfine ?? true);
}

/** Folders besides the workspace that present may read from while confined. */
export function presentRoots(ctx: PluginContext<AgentConfig>): string[] {
  const v = ctx.storage.kv.get<unknown>("presentRoots");
  const list = Array.isArray(v) ? v : (ctx.config.presentRoots ?? []);
  return list.filter((r): r is string => typeof r === "string" && r !== "");
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
            enumNames: ["Queue", "Interrupt"],
          },
          defaultProvider: { type: "string", title: "Default provider" },
          defaultModel: { type: "string", title: "Default model" },
          presentConfine: {
            type: "boolean",
            title: "Confine present to the workspace",
            description:
              "The present tool may only share files under the project workspace and the folders below. Turning this off lets it share any path valet can read, and limits the tool to owner runs.",
          },
          presentRoots: {
            type: "array",
            items: { type: "string" },
            title: "Extra present folders",
            description: "Absolute folders present may also read from while it is confined.",
          },
        },
      },
      get: () => {
        const m = storedModel(ctx);
        return {
          defaultQueueMode: ctx.storage.kv.get<string>("defaultQueueMode") ?? "",
          defaultProvider: m?.provider ?? "",
          defaultModel: m?.model ?? "",
          presentConfine: presentConfined(ctx),
          presentRoots: presentRoots(ctx),
        };
      },
      set: (v) => {
        const q = v.defaultQueueMode;
        if (typeof q !== "string" || !(QUEUE_MODES as readonly string[]).includes(q))
          throw new Error(`defaultQueueMode must be one of: ${QUEUE_MODES.join(", ")}`);
        const { presentConfine: confine, presentRoots: roots } = v;
        if (confine !== undefined && typeof confine !== "boolean")
          throw new Error("presentConfine must be a boolean");
        if (roots !== undefined && !(Array.isArray(roots) && roots.every((r) => typeof r === "string")))
          throw new Error("presentRoots must be a list of folders");
        ctx.storage.kv.set("defaultQueueMode", q);
        if (confine !== undefined) ctx.storage.kv.set("presentConfine", confine);
        if (roots !== undefined)
          ctx.storage.kv.set(
            "presentRoots",
            (roots as string[]).map((r) => r.trim()).filter((r) => r !== ""),
          );
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
