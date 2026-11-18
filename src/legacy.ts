import type { ModelRef, SessionSettings } from "@valethq/sdk";
import type { Catalog } from "./catalog";
import type { AgentCtx } from "./env";
import { isModelRef } from "./model";

type Stored = ModelRef & { fallbacks?: unknown };

/** The stored model with legacy ids rewritten (11.1), or undefined when nothing changes. */
export function rewritten(model: unknown, catalog: Catalog): Stored | undefined {
  if (!isModelRef(model)) return undefined;
  const next: Stored = catalog.normalize(model);
  let changed = next !== model;
  if (Array.isArray(model.fallbacks)) {
    const fallbacks = model.fallbacks.map((f) => (isModelRef(f) ? catalog.normalize(f) : f));
    if (fallbacks.some((f, i) => f !== (model.fallbacks as unknown[])[i])) {
      next.fallbacks = fallbacks;
      changed = true;
    }
  }
  return changed ? { ...model, ...next } : undefined;
}

/** Once at boot: model refs in projects and sessions that still spell effort or speed in the id. */
export async function rewriteLegacyRefs(ctx: AgentCtx, catalog: Catalog): Promise<number> {
  let count = 0;
  for (const project of ctx.store.projects.list()) {
    const model = rewritten(project.settings.model, catalog);
    if (model) {
      await ctx.store.projects
        .update(project.id, { settings: { ...project.settings, model } })
        .catch(() => {});
      count++;
    }
    for (const session of ctx.store.sessions.list({ projectId: project.id })) {
      const next = rewritten(session.settings.model, catalog);
      if (!next) continue;
      const settings: SessionSettings = { ...session.settings, model: next as SessionSettings["model"] };
      await ctx.store.sessions.update(session.id, { settings }).catch(() => {});
      count++;
    }
  }
  if (count > 0) ctx.log.info("model refs rewritten to model + options", { count });
  return count;
}
