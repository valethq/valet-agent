import type { PluginContext, ToolDefinition } from "@valethq/sdk";
import type { AgentSessions } from "./agents";
import type { Catalog } from "./catalog";
import type { ToolRouter } from "./surface";
import type { AgentConfig } from "./model";

export type AgentCtx = PluginContext<AgentConfig>;

export interface Env {
  ctx: AgentCtx;
  agents: AgentSessions;
  catalog: Catalog;
  tools: ToolRouter;
  lastUsage: Map<string, Record<string, number>>;
  /** valet-agent's own tools (present, subagent), rebuilt per run so settings changes apply. */
  ownTools(): ToolDefinition[];
}
