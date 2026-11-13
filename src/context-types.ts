import type { ModelInfo, ModelMessage, Role } from "@valethq/sdk";

export interface PersonaFile {
  path: string;
  role: "agents" | "user" | "memory" | "soul" | "identity" | "daily" | "other";
  content: string;
}

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  estimatedTokens: number;
  files: PersonaFile[];
}

export interface ContextManager {
  /** model-kind: full prompt within budget (persona files, compaction summary, recent history). */
  build(req: { sessionId: string; runId: string; model: ModelInfo; role: Role }): Promise<BuiltContext>;
  /** agent-kind: persona/memory preamble for a new or reseeded remote session. */
  preamble(req: {
    sessionId: string;
    role: Role;
    model?: { id: string; contextWindow?: number };
  }): Promise<string>;
  shouldCompact(req: {
    sessionId: string;
    model: ModelInfo;
    lastUsage: { inputTokens?: number; contextTokens?: number };
  }): Promise<boolean>;
  /**
   * Records a `compaction` part in the same chat (never a new session). `by: valet` summarizes the
   * chat since the last valet summary; `by: harness` writes a marker only.
   */
  compact(req: { sessionId: string; reason: "auto" | "manual"; by: CompactionBy }): Promise<void>;
}

export type CompactionBy =
  | { kind: "valet"; summarize(transcript: string): Promise<string> }
  | { kind: "harness"; label: string };

declare module "@valethq/sdk" {
  interface ValetScopes {
    context: ContextManager;
  }
}
