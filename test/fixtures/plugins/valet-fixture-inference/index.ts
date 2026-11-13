import {
  type AgentEvent,
  definePlugin,
  type InferenceChunk,
  type ModelContent,
  type ModelInfo,
} from "@valethq/sdk";

const models: ModelInfo[] = ["m1", "m2"].map((id) => ({
  id,
  name: id,
  contextWindow: 1000,
  maxOutputTokens: 100,
  input: ["text"],
  reasoning: false,
}));

const textOf = (content: ModelContent[]): string =>
  content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

export default definePlugin({
  activate(ctx) {
    const log: Record<string, unknown>[] = [];
    ctx.http.route("GET", "/log", () => Response.json(log), { public: true });

    ctx.scopes.provide(
      "inference",
      {
        id: "fake-agent",
        kind: "agent",
        label: "Fake agent",
        listModels: async () => models,
        async open(opts) {
          log.push({ op: "open", resumeId: opts.resumeId ?? null, model: opts.model });
          return {
            resumeId: opts.resumeId ?? `remote-${opts.sessionId}`,
            async *prompt(input, signal): AsyncIterable<AgentEvent> {
              const text = textOf(input.content);
              log.push({ op: "prompt", text, preamble: input.preamble ?? null });
              if (text.startsWith("slow")) {
                yield { type: "text-delta", text: "working" };
                await untilAborted(signal);
                yield { type: "finish", reason: "cancelled" };
                return;
              }
              if (text.startsWith("tools")) {
                yield {
                  type: "tool-start",
                  callId: "c1",
                  name: "shell",
                  title: "Run ls",
                  input: { cmd: "ls" },
                };
                yield { type: "tool-update", callId: "c1", outputDelta: "out", status: "running" };
                yield { type: "tool-end", callId: "c1", status: "done" };
              }
              if (text.startsWith("exit")) {
                yield { type: "tool-start", callId: "c1", name: "shell", input: { cmd: "oops" } };
                yield { type: "tool-end", callId: "c1", status: "error", output: "nope", exitCode: 3 };
              }
              yield { type: "reasoning-delta", text: "think" };
              yield { type: "text-delta", text: "Hello, " };
              if (text.startsWith("note")) yield { type: "notice", level: "warning", text: "heads up" };
              yield { type: "text-delta", text };
              yield { type: "usage", contextTokens: 100, inputTokens: 90, outputTokens: 10 };
              yield { type: "finish", reason: "stop" };
            },
            async setModel(model) {
              log.push({ op: "setModel", model });
            },
            async close() {},
          };
        },
      },
      { key: "fake-agent" },
    );

    ctx.scopes.provide(
      "inference",
      {
        id: "fake-model",
        kind: "model",
        label: "Fake model",
        listModels: async () => models,
        async *stream(req, signal): AsyncIterable<InferenceChunk> {
          const last = req.messages.at(-1);
          if (last?.role === "tool") {
            yield { type: "text-delta", text: `done: ${textOf(last.content)}` };
            yield { type: "usage", inputTokens: 5, outputTokens: 5 };
            yield { type: "finish", reason: "stop" };
            return;
          }
          const text = last ? textOf(last.content) : "";
          if (text.startsWith("tool")) {
            yield { type: "tool-call", callId: "t1", name: "echo", input: { a: 1 } };
            yield { type: "finish", reason: "tool-calls" };
            return;
          }
          if (text.startsWith("slow")) {
            yield { type: "text-delta", text: "working" };
            await untilAborted(signal);
            yield { type: "finish", reason: "cancelled" };
            return;
          }
          yield { type: "text-delta", text: `model says ${text}` };
          yield { type: "finish", reason: "stop" };
        },
      },
      { key: "fake-model" },
    );

    ctx.scopes.provide(
      "inference",
      {
        id: "fake-bad",
        kind: "model",
        label: "Always fails",
        listModels: async () => [],
        // biome-ignore lint/correctness/useYield: fails before any output
        async *stream(): AsyncIterable<InferenceChunk> {
          throw new Error("boom");
        },
      },
      { key: "fake-bad" },
    );
  },
});
