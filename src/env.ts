import type { PluginContext } from "@valethq/sdk";
import type { AgentSessions } from "./agents";
import type { ToolRouter } from "./surface";
import type { AgentConfig } from "./model";

export type AgentCtx = PluginContext<AgentConfig>;

export interface Env {
  ctx: AgentCtx;
  agents: AgentSessions;
  tools: ToolRouter;
  lastUsage: Map<string, Record<string, number>>;
}
