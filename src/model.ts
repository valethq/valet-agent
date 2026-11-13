import type { PluginContext, Project, Session } from "@valethq/sdk";

export interface ModelRef {
  provider: string;
  model: string;
}
export interface ResolvedModel extends ModelRef {
  fallbacks: ModelRef[];
}
export interface AgentConfig {
  defaultModel?: ModelRef;
}

export const DEFAULT_MODEL: ModelRef = { provider: "devin-cli", model: "claude-opus-5-5-medium" };

/** Config with the settings-panel override applied; kv wins over config.json. */
export function configFor(ctx: PluginContext<AgentConfig>): AgentConfig {
  const m = ctx.storage.kv.get<ModelRef>("defaultModel");
  return isModelRef(m)
    ? { ...ctx.config, defaultModel: { provider: m.provider, model: m.model } }
    : ctx.config;
}

export const isModelRef = (v: unknown): v is ModelRef & { fallbacks?: unknown } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ModelRef).provider === "string" &&
  typeof (v as ModelRef).model === "string";

export function resolveModel(
  session: Session,
  project: Project | undefined,
  config: AgentConfig,
): ResolvedModel {
  const chosen = [session.settings.model, project?.settings.model, config.defaultModel].find(isModelRef);
  if (!chosen) return { ...DEFAULT_MODEL, fallbacks: [] };
  const fallbacks = Array.isArray(chosen.fallbacks) ? chosen.fallbacks.filter(isModelRef) : [];
  return {
    provider: chosen.provider,
    model: chosen.model,
    fallbacks: fallbacks.map(({ provider, model }) => ({ provider, model })),
  };
}
