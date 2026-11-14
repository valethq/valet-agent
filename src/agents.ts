import type { AgentProvider, AgentSession } from "@valethq/sdk";
import type { AgentCtx } from "./env";
import type { ToolRouter } from "./surface";

export interface AgentEntry {
  providerId: string;
  model: string;
  session: AgentSession;
  needsPreamble: boolean;
  notedCompactions: number;
}

/** One open AgentSession per valet session, kept for the life of the process. */
export class AgentSessions {
  readonly #entries = new Map<string, AgentEntry>();
  readonly #ctx: AgentCtx;
  readonly #tools: ToolRouter;

  constructor(ctx: AgentCtx, tools: ToolRouter) {
    this.#ctx = ctx;
    this.#tools = tools;
  }

  async acquire(provider: AgentProvider, sessionId: string, cwd: string, model: string): Promise<AgentEntry> {
    let reseed = false;
    const existing = this.#entries.get(sessionId);
    if (existing?.providerId === provider.id) {
      if (existing.model === model) return existing;
      if (existing.session.setModel) {
        await existing.session.setModel(model);
        existing.model = model;
        return existing;
      }
      reseed = true;
    }
    await this.drop(sessionId);
    const state = this.#ctx.store.sessions.get(sessionId)?.providerState[provider.id] as
      | { resumeId?: string }
      | undefined;
    const resumeId = reseed ? undefined : state?.resumeId;
    const session = await provider.open({
      sessionId,
      cwd,
      model,
      ...(resumeId ? { resumeId } : {}),
      tools: this.#tools.surface(sessionId),
      signal: this.#ctx.signal,
    });
    this.#ctx.store.sessions.setProviderState(sessionId, provider.id, { resumeId: session.resumeId });
    const entry = {
      providerId: provider.id,
      model,
      session,
      needsPreamble: session.resumeId !== resumeId,
      notedCompactions: 0,
    };
    this.#entries.set(sessionId, entry);
    return entry;
  }

  async drop(sessionId: string): Promise<void> {
    const entry = this.#entries.get(sessionId);
    this.#entries.delete(sessionId);
    await entry?.session.close().catch((error: unknown) => {
      this.#ctx.log.warn("agent session close failed", { sessionId, error: String(error) });
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((id) => this.drop(id)));
  }
}
