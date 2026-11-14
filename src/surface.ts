import type { PluginContext, Role, ToolDefinition, ToolResult, ToolSpec, ToolSurface } from "@valethq/sdk";
import type { AgentConfig } from "./model";
import type { RunCtx } from "./run-types";
import { presentedOf } from "./present";
import { listTools } from "./tools";

interface Active {
  rc: RunCtx;
  defs: Map<string, ToolDefinition>;
}

const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/**
 * One ToolSurface per valet session, handed to agent providers at open(). `enter` snapshots the tools a
 * run may use (role and exposure config applied); `call` runs the tool.call gate and then the tool, for
 * whichever run is active.
 */
export class ToolRouter {
  readonly #ctx: PluginContext<AgentConfig>;
  readonly #active = new Map<string, Active>();
  readonly #surfaces = new Map<string, ToolSurface>();

  constructor(ctx: PluginContext<AgentConfig>) {
    this.#ctx = ctx;
  }

  surface(sessionId: string): ToolSurface {
    let surface = this.#surfaces.get(sessionId);
    if (!surface) {
      surface = {
        list: () => this.#list(sessionId),
        call: (name, input, call) => this.#call(sessionId, name, input, call),
        authorize: (name, input, call) => this.#authorize(sessionId, name, input, call.callId),
      };
      this.#surfaces.set(sessionId, surface);
    }
    return surface;
  }

  async enter(rc: RunCtx): Promise<void> {
    const found = await listTools(this.#ctx, {
      sessionId: rc.sessionId,
      projectId: rc.projectId,
      role: rc.role as Role,
    });
    const exposed = this.#ctx.config.exposedTools;
    const defs = exposed ? new Map([...found].filter(([name]) => exposed.includes(name))) : found;
    this.#active.set(rc.sessionId, { rc, defs });
  }

  leave(rc: RunCtx): void {
    if (this.#active.get(rc.sessionId)?.rc === rc) this.#active.delete(rc.sessionId);
  }

  forget(sessionId: string): void {
    this.#active.delete(sessionId);
    this.#surfaces.delete(sessionId);
  }

  #list(sessionId: string): ToolSpec[] {
    const active = this.#active.get(sessionId);
    if (!active) return [];
    return [...active.defs.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  /** The `tool.call` gate: any before hook may deny or rewrite the input. */
  async #authorize(
    sessionId: string,
    name: string,
    input: unknown,
    callId: string,
  ): Promise<{ input: unknown } | { denied: string }> {
    const rc = this.#active.get(sessionId)?.rc;
    if (!rc) return { denied: "no valet run is active for this session" };
    const gate = await this.#ctx.events.emit("tool.call", {
      runId: rc.runId,
      callId,
      name,
      input,
      role: rc.role,
    });
    if (gate.cancelled) return { denied: gate.denied?.reason ?? gate.cancelReason ?? "denied" };
    return { input: gate.payload.input };
  }

  async #call(
    sessionId: string,
    name: string,
    input: unknown,
    call: { callId: string; signal: AbortSignal },
  ): Promise<ToolResult> {
    const active = this.#active.get(sessionId);
    if (!active) return failure("no valet run is active for this session");
    const { rc, defs } = active;
    const def = defs.get(name);
    if (!def) return failure(`unknown tool "${name}"`);
    const verdict = await this.#authorize(sessionId, name, input, call.callId);
    if ("denied" in verdict) return failure(`Denied: ${verdict.denied}`);
    const signals = [rc.signal, call.signal, ...(def.timeoutMs ? [AbortSignal.timeout(def.timeoutMs)] : [])];
    try {
      const result = await def.invoke(verdict.input, {
        sessionId,
        runId: rc.runId,
        callId: call.callId,
        role: rc.role,
        caller: rc.caller,
        cwd: rc.cwd,
        signal: AbortSignal.any(signals),
        // spec-gap: the provider's call id is not a tool-call part here, so progress has nowhere to go yet.
        progress: () => {},
      });
      rc.parts.files(presentedOf(result));
      return result;
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
}
