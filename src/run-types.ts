import type { Caller, ModelContent, Role, Store } from "@valethq/sdk";
import type { PartStream } from "./parts";

export type Outcome = { status: "stop" } | { status: "cancelled" } | { status: "error"; error: string };

export interface RunCtx {
  sessionId: string;
  projectId: string;
  cwd: string;
  runId: string;
  triggerSeq: number;
  role: Role;
  caller: Caller;
  content: ModelContent[];
  parts: PartStream;
  signal: AbortSignal;
  store: Store;
  usage(u: { contextTokens?: number; inputTokens?: number; outputTokens?: number }): void;
}
