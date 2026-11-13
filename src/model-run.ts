import type { ModelContent, ModelInfo, ModelMessage, ModelProvider, ToolDefinition } from "@valethq/sdk";
import type { Env } from "./env";
import type { ModelRef } from "./model";
import type { Outcome, RunCtx } from "./run-types";

const MAX_STEPS = 25;

interface Call {
  callId: string;
  name: string;
  input: unknown;
}

async function listTools(env: Env, rc: RunCtx): Promise<Map<string, ToolDefinition>> {
  const defs = new Map<string, ToolDefinition>();
  for (const provider of env.ctx.scopes.all("tools")) {
    const list = await provider.impl.list({
      sessionId: rc.sessionId,
      projectId: rc.projectId,
      role: rc.role,
    });
    for (const def of list) if (!defs.has(def.name)) defs.set(def.name, def);
  }
  return defs;
}

const toolMessage = (callId: string, content: ModelContent[], isError: boolean): ModelMessage => ({
  role: "tool",
  callId,
  content,
  ...(isError ? { isError } : {}),
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
  const gate = await env.ctx.events.emit("tool.call", { ...call, runId: rc.runId, role: rc.role });
  if (gate.cancelled)
    return fail("denied", `Denied: ${gate.denied?.reason ?? gate.cancelReason ?? "denied"}`);
  rc.parts.update(call.callId, { status: "running" });
  const signal = def.timeoutMs ? AbortSignal.any([rc.signal, AbortSignal.timeout(def.timeoutMs)]) : rc.signal;
  try {
    const result = await def.invoke(call.input, {
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
  const defs = await listTools(env, rc);
  const tools = [...defs.values()].map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const messages = [...built.messages];
  const meta = { sessionId: rc.sessionId, runId: rc.runId };
  let inputTokens = 0;
  let outputTokens = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const calls: Call[] = [];
    let text = "";
    let finish: { reason: string; error?: string } | undefined;
    const req = { model: cand.model, system: built.system, messages, tools, meta };
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
        case "tool-call":
          calls.push({ callId: chunk.callId, name: chunk.name, input: chunk.input });
          rc.parts.start({ ...chunk, status: "pending" });
          break;
        case "usage":
          inputTokens += chunk.inputTokens;
          outputTokens += chunk.outputTokens;
          rc.usage({
            inputTokens,
            outputTokens,
            contextTokens: chunk.inputTokens + (chunk.cacheReadTokens ?? 0),
          });
          break;
        case "finish":
          finish = chunk;
          break;
      }
    }
    if (rc.signal.aborted || finish?.reason === "cancelled") return { status: "cancelled" };
    if (finish?.reason !== "stop" && finish?.reason !== "tool-calls" && finish?.reason !== "length") {
      return { status: "error", error: finish?.error ?? "stream ended without a finish chunk" };
    }
    if (calls.length === 0) return { status: "stop" };
    const content: ModelContent[] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((c) => ({ type: "tool-call" as const, ...c })),
    ];
    messages.push({ role: "assistant", content });
    for (const call of calls) messages.push(await callTool(env, rc, defs, call));
  }
  return { status: "error", error: `tool loop exceeded ${MAX_STEPS} steps` };
}
