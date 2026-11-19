import type { InferenceProvider, ModelInfo, ModelRef } from "@valethq/sdk";
import type { AgentCtx } from "./env";

/** One row of valet-agent's `models` config: an override of a listed model, a custom model, or ("*") a provider default. */
export interface CatalogRow {
  provider: string;
  /** Model id, or "*" for the provider's models that have no row of their own. */
  id: string;
  show?: boolean;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  efforts?: string[];
  defaultEffort?: string;
  fast?: boolean;
  /** Not in the provider's list; its id is passed to the provider as is. */
  custom?: boolean;
}

export interface CatalogModel extends ModelInfo {
  /** In pickers. */
  show: boolean;
  custom: boolean;
  /** What the provider lists, before overrides; absent for custom models. */
  base?: ModelInfo;
}

export interface CatalogProvider {
  provider: string;
  kind: InferenceProvider["kind"];
  label: string;
  icon?: string;
  error?: string;
  models: CatalogModel[];
}

const CUSTOM_DEFAULTS = { contextWindow: 128_000, maxOutputTokens: 32_000 } as const;

const OVERRIDES = ["name", "contextWindow", "maxOutputTokens", "efforts", "defaultEffort", "fast"] as const;

function overlay(info: ModelInfo, row: CatalogRow | undefined): ModelInfo {
  if (row === undefined) return info;
  const out: ModelInfo = { ...info };
  for (const key of OVERRIDES) if (row[key] !== undefined) Object.assign(out, { [key]: row[key] });
  return out;
}

/** A provider's list with this provider's rows applied, then its custom models. */
export function mergeCatalog(provider: string, listed: ModelInfo[], rows: CatalogRow[]): CatalogModel[] {
  const own = rows.filter((r) => r.provider === provider);
  const star = own.find((r) => r.id === "*");
  const byId = new Map(own.filter((r) => r.id !== "*").map((r) => [r.id, r]));
  const out: CatalogModel[] = listed.map((info) => {
    const row = byId.get(info.id);
    byId.delete(info.id);
    return {
      ...overlay(info, row),
      show: row?.show ?? star?.show ?? info.hidden !== true,
      custom: false,
      base: info,
    };
  });
  for (const row of byId.values()) {
    if (row.custom !== true) continue;
    const info: ModelInfo = {
      id: row.id,
      name: row.id,
      ...CUSTOM_DEFAULTS,
      input: ["text", "image"],
      reasoning: (row.efforts?.length ?? 0) > 0,
    };
    out.push({ ...overlay(info, row), show: row.show ?? true, custom: true });
  }
  return out;
}

const SPEED = /-(fast|priority|lightning)$/;
const EFFORT = /-(none|minimal|low|medium|high|xhigh|max|ultra)$/;

/**
 * A ref from before options (11.1): "claude-opus-5-5-high-fast" over a listed "claude-opus-5-5" becomes that
 * model with effort "high" and fast mode. A speed suffix is peeled first and kept when that id is listed
 * (`plain-high-fast` over `plain-high`), otherwise the effort suffix is peeled too. Anything else is unchanged.
 */
export function normalizeRef<T extends ModelRef>(ref: T, listed: readonly { id: string }[] | undefined): T {
  if (listed === undefined || listed.some((m) => m.id === ref.model)) return ref;
  const has = (id: string) => listed.some((m) => m.id === id);
  let model = ref.model;
  let fast = false;
  const speed = SPEED.exec(model);
  if (speed) {
    model = model.slice(0, speed.index);
    fast = true;
    if (has(model)) {
      return { ...ref, model, ...(ref.fast === undefined ? { fast: true } : {}) };
    }
  }
  const effort = EFFORT.exec(model);
  if (effort) model = model.slice(0, effort.index);
  if (!has(model) || model === ref.model) return ref;
  return {
    ...ref,
    model,
    ...(effort && ref.effort === undefined ? { effort: effort[1] } : {}),
    ...(fast && ref.fast === undefined ? { fast: true } : {}),
  };
}

/**
 * Options a run sends. An effort the model doesn't list, and fast mode it lacks, are dropped.
 * Unset effort runs the provider's own `defaultEffort`, so a catalog default is sent only when a row
 * overrides that value, or the model is custom and the provider has no listing to apply.
 */
export function runOptions(ref: ModelRef, info: ModelInfo): { effort?: string; fast?: boolean } {
  const efforts = info.efforts ?? [];
  const allowed = (effort: string | undefined): effort is string =>
    effort !== undefined && efforts.includes(effort);
  const row = info as CatalogModel;
  const overridden =
    row.base !== undefined
      ? info.defaultEffort !== row.base.defaultEffort
        ? info.defaultEffort
        : undefined
      : row.custom === true
        ? info.defaultEffort
        : undefined;
  const effort = allowed(ref.effort) ? ref.effort : allowed(overridden) ? overridden : undefined;
  const fast = info.fast === true ? ref.fast : undefined;
  return { ...(effort === undefined ? {} : { effort }), ...(fast === undefined ? {} : { fast }) };
}

const iconOf = (impl: object): { icon?: string } => {
  const icon = (impl as { icon?: unknown }).icon;
  return typeof icon === "string" && icon !== "" ? { icon } : {};
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** valet-agent's model catalog (11.1). Keeps each provider's last list so refs can be normalized without waiting. */
export class Catalog {
  readonly #ctx: AgentCtx;
  readonly #listed = new Map<string, ModelInfo[]>();

  constructor(ctx: AgentCtx) {
    this.#ctx = ctx;
  }

  #rows(): CatalogRow[] {
    return this.#ctx.config.models ?? [];
  }

  async #list(provider: string, impl: InferenceProvider): Promise<ModelInfo[]> {
    const models = await impl.listModels();
    this.#listed.set(provider, models);
    return models;
  }

  async providers(): Promise<CatalogProvider[]> {
    const rows = this.#rows();
    return Promise.all(
      this.#ctx.scopes.all("inference").map(async ({ key, impl }) => {
        const head = { provider: key, kind: impl.kind, label: impl.label, ...iconOf(impl) };
        try {
          return { ...head, models: mergeCatalog(key, await this.#list(key, impl), rows) };
        } catch (error) {
          const cached = this.#listed.get(key) ?? [];
          return { ...head, error: errorText(error), models: mergeCatalog(key, cached, rows) };
        }
      }),
    );
  }

  /** The catalog entry a run uses; a model nobody lists runs with unknown limits. */
  async info(ref: ModelRef): Promise<ModelInfo> {
    const impl = this.#ctx.scopes.maybe("inference", ref.provider);
    const listed = impl
      ? await this.#list(ref.provider, impl).catch(() => this.#listed.get(ref.provider) ?? [])
      : [];
    const found = mergeCatalog(ref.provider, listed, this.#rows()).find((m) => m.id === ref.model);
    if (found) {
      // `base` and `custom` stay on so runOptions can tell a row's defaultEffort from the provider's.
      const { show: _s, ...info } = found;
      return info;
    }
    return {
      id: ref.model,
      name: ref.model,
      contextWindow: 0,
      maxOutputTokens: 0,
      input: ["text"],
      reasoning: false,
    };
  }

  /** `normalizeRef` against what the provider listed last, plus custom rows. */
  normalize<T extends ModelRef>(ref: T): T {
    const listed = this.#listed.get(ref.provider);
    if (listed === undefined) return ref;
    const custom = this.#rows().filter((r) => r.provider === ref.provider && r.custom === true);
    return normalizeRef(ref, [...listed, ...custom]);
  }

  /** Lists every provider once, so `normalize` has something to go on. */
  async warm(): Promise<void> {
    await Promise.all(
      this.#ctx.scopes.all("inference").map(({ key, impl }) => this.#list(key, impl).catch(() => [])),
    );
  }
}
