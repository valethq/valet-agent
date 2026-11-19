import type { ModelRef, Project, Session } from "@valethq/sdk";
import type { CatalogRow } from "./catalog";

export type { ModelRef };

export interface ResolvedModel extends ModelRef {
  fallbacks: ModelRef[];
}

/** valet-agent's config; core fills in the manifest's defaults (12.1). */
export interface AgentConfig {
  defaultModel?: ModelRef & { fallbacks?: ModelRef[] };
  /** The model catalog's rows (11.1). */
  models?: CatalogRow[];
  /** What a message sent during a run does, for every session. */
  queueMode?: "queue" | "interrupt";
  /** Seconds the subagent tool waits to group background subagents that end close together into one wake-up. 0 wakes for each. */
  subagentWakeGroupSeconds?: number;
  /** Tool names agent providers may see. Unset exposes every tools@1 tool the run's role allows. */
  exposedTools?: string[];
  /** Whether the present tool is limited to the project workspace plus presentRoots. */
  presentConfine?: boolean;
  /** Directories besides the project workspace that the present tool may read from. */
  presentRoots?: string[];
}

export const DEFAULT_MODEL: ModelRef = { provider: "devin-cli", model: "claude-opus-5-5", effort: "medium" };

export const isModelRef = (v: unknown): v is ModelRef & { fallbacks?: unknown } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ModelRef).provider === "string" &&
  typeof (v as ModelRef).model === "string";

/** Just the ref's own fields, so stray keys never reach a provider. */
export function refOf(v: ModelRef): ModelRef {
  return {
    provider: v.provider,
    model: v.model,
    ...(typeof v.effort === "string" ? { effort: v.effort } : {}),
    ...(typeof v.fast === "boolean" ? { fast: v.fast } : {}),
  };
}

export function resolveModel(
  session: Session,
  project: Project | undefined,
  config: AgentConfig,
): ResolvedModel {
  const chosen = [session.settings.model, project?.settings.model, config.defaultModel].find(isModelRef);
  if (!chosen) return { ...DEFAULT_MODEL, fallbacks: [] };
  const fallbacks = Array.isArray(chosen.fallbacks) ? chosen.fallbacks.filter(isModelRef) : [];
  return { ...refOf(chosen), fallbacks: fallbacks.map(refOf) };
}

/** "provider:model" or a bare model on `current`'s provider; undefined when the text names nothing. */
export function parseRef(
  text: string,
  current: ModelRef,
  hasProvider: (key: string) => boolean,
): ModelRef | undefined {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const [first, ...rest] = words;
  if (first === undefined) return undefined;
  const sep = first.indexOf(":");
  const ref: ModelRef =
    sep > 0 && hasProvider(first.slice(0, sep))
      ? { provider: first.slice(0, sep), model: first.slice(sep + 1) }
      : { provider: current.provider, model: first };
  for (const word of rest) {
    if (word === "fast") ref.fast = true;
    else if (word === "standard" || word === "slow") ref.fast = false;
    else ref.effort = word;
  }
  return ref;
}
