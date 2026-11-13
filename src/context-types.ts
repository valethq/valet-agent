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
  /** Opens a compaction part in the chat (in_progress), never a new session. */
  compactionStart(req: { sessionId: string; by: string }): Promise<{ compactionId: string }>;
  /** Closes the compaction part that compactionStart opened. */
  compactionEnd(req: {
    sessionId: string;
    compactionId: string;
    status: "completed" | "failed" | "cancelled";
    summary?: string;
    error?: string;
  }): Promise<void>;
  /** valet compacts: opens a part, summarizes the chat since the last valet summary, closes the part. */
  compact(req: {
    sessionId: string;
    reason: "auto" | "manual";
    summarize(transcript: string): Promise<string>;
  }): Promise<void>;
}

declare module "@valethq/sdk" {
  interface ValetScopes {
    context: ContextManager;
  }
}
