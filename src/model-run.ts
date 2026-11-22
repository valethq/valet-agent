import { runOptions } from "./catalog";
import type { ModelContent, ModelInfo, ModelMessage, ModelProvider, ToolDefinition } from "@valethq/sdk";
import { autoCompact } from "./compactions";
import type { Env } from "./env";
import type { ModelRef } from "./model";
import type { Outcome, RunCtx } from "./run-types";
import { presentedOf } from "./present";
import { emitToolCall, listTools } from "./tools";

const MAX_STEPS = 25;

interface Call {
  callId: string;
  name: string;
  input: unknown;
}

type Piece = { type: "text"; text: string } | { type: "tool"; call: Call };

const toolMessage = (callId: string, content: ModelContent[], isError: boolean): ModelMessage => ({
  role: "tool",
  callId,
  content,
  ...(isError ? { isError } : {}),
});

const assistantContent = (pieces: Piece[]): ModelContent[] =>
  pieces.map((piece) => {
    if (piece.type === "text") return { type: "text", text: piece.text };
    const { call } = piece;
    return { type: "tool-call", callId: call.callId, name: call.name, input: call.input };
  });

async function callTool(
  env: Env,
  rc: RunCtx,
  defs: Map<string, ToolDefinition>,
  call: Call,
): Promise<ModelMessage> {
  const fail = (status: "error" | "denied", text: string): ModelMessage => {
    rc.parts.end(call.callId, status, { output: text });
    return toolMessage(call.callId, [{ type: "text", text }], true);
  };
  const def = defs.get(call.name);
  if (!def) return fail("error", `unknown tool "${call.name}"`);
  const gate = await emitToolCall(env.ctx, rc, call);
  if (gate.cancelled)
    return fail("denied", `Denied: ${gate.denied?.reason ?? gate.cancelReason ?? "denied"}`);
  const original = call.input;
  call.input = gate.payload.input;
  rc.parts.update(call.callId, {
    status: "running",
    ...(gate.payload.input !== original ? { input: gate.payload.input } : {}),
  });
  const signal = def.timeoutMs ? AbortSignal.any([rc.signal, AbortSignal.timeout(def.timeoutMs)]) : rc.signal;
  try {
    const result = await def.invoke(gate.payload.input, {
      sessionId: rc.sessionId,
      runId: rc.runId,
      callId: call.callId,
      role: rc.role,
      caller: rc.caller,
      cwd: rc.cwd,
      signal,
      progress: ({ outputDelta }) => rc.parts.update(call.callId, { outputDelta }),
    });
    const output = result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    rc.parts.end(call.callId, result.isError ? "error" : "done", { output, result });
    rc.parts.files(presentedOf(result));
    return toolMessage(call.callId, result.content, result.isError === true);
  } catch (error) {
    return fail("error", error instanceof Error ? error.message : String(error));
  }
}

export async function runModel(
  env: Env,
  provider: ModelProvider,
  cand: ModelRef,
  rc: RunCtx,
  info: ModelInfo,
): Promise<Outcome> {
  const built = await env.ctx.scopes
    .get("context")
    .build({ sessionId: rc.sessionId, runId: rc.runId, model: info, role: rc.role });
  const defs = await listTools(
    env.ctx,
    { sessionId: rc.sessionId, projectId: rc.projectId, role: rc.role, caller: rc.caller },
    env.ownTools(),
  );
  const tools = [...defs.values()].map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const messages = [...built.messages];
  const meta = { sessionId: rc.sessionId, runId: rc.runId };
  let inputTokens = 0;
  let outputTokens = 0;
  let contextTokens = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (rc.signal.aborted) return { status: "cancelled" };
    const calls: Call[] = [];
    const pieces: Piece[] = [];
    let text = "";
    const flushText = (): void => {
      if (text === "") return;
      pieces.push({ type: "text", text });
      text = "";
    };
    let finish: { reason: string; error?: string } | undefined;
    const req = { model: cand.model, ...runOptions(cand, info), system: built.system, messages, tools, meta };
    for await (const chunk of provider.stream(req, rc.signal)) {
      if (rc.signal.aborted) return { status: "cancelled" };
      switch (chunk.type) {
        case "text-delta":
          text += chunk.text;
          rc.parts.text("text", chunk.text);
          break;
        case "reasoning-delta":
          rc.parts.text("reasoning", chunk.text);
          break;
        case "tool-call": {
          flushText();
          const call: Call = { callId: chunk.callId, name: chunk.name, input: chunk.input };
          calls.push(call);
          pieces.push({ type: "tool", call });
          rc.parts.start({ ...chunk, status: "pending" });
          break;
        }
        case "usage":
          inputTokens += chunk.inputTokens;
          outputTokens += chunk.outputTokens;
          contextTokens = chunk.inputTokens + (chunk.cacheReadTokens ?? 0);
          rc.usage({ inputTokens, outputTokens, contextTokens });
          break;
        case "finish":
          finish = chunk;
          break;
      }
    }
    flushText();
    if (rc.signal.aborted || finish?.reason === "cancelled") return { status: "cancelled" };
    if (finish?.reason !== "stop" && finish?.reason !== "tool-calls" && finish?.reason !== "length") {
      return { status: "error", error: finish?.error ?? "stream ended without a finish chunk" };
    }
    if (calls.length === 0) {
      await autoCompact(env, provider, cand, info, rc, contextTokens);
      if (rc.signal.aborted) return { status: "cancelled" };
      return { status: "stop" };
    }
    const toolMessages: ModelMessage[] = [];
    for (const call of calls) {
      if (rc.signal.aborted) return { status: "cancelled" };
      toolMessages.push(await callTool(env, rc, defs, call));
    }
    messages.push({ role: "assistant", content: assistantContent(pieces) }, ...toolMessages);
  }
  return { status: "error", error: `tool loop exceeded ${MAX_STEPS} steps` };
}
