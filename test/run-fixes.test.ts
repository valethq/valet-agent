import { describe, expect, test } from "bun:test";
import type {
  AgentEvent,
  AgentProvider,
  InferenceChunk,
  ModelInfo,
  ModelMessage,
  ModelProvider,
  PartData,
} from "@valethq/sdk";
import { runAgent } from "../src/agent-run";
import { compactHarness, compactWithValet, CompactionRecorder } from "../src/compactions";
import type { Env } from "../src/env";
import { runModel } from "../src/model-run";
import type { RunCtx } from "../src/run-types";

const INFO: ModelInfo = {
  id: "m",
  name: "m",
  contextWindow: 1000,
  maxOutputTokens: 100,
  input: ["text"],
  reasoning: false,
};
const REF = { provider: "p", model: "m" };
const provider = { id: "p", label: "Fake agent" } as AgentProvider;

const chunks = (...list: InferenceChunk[]): InferenceChunk[] => list;

async function summarize(list: InferenceChunk[], signal = new AbortController().signal): Promise<string> {
  let summary = "";
  const model = {
    kind: "model",
    async *stream() {
      yield* list;
    },
  } as unknown as ModelProvider;
  const env = {
    ctx: {
      scopes: {
        get: () => ({
          compact: async (req: { summarize(transcript: string): Promise<string> }) => {
            summary = await req.summarize("TRANSCRIPT");
          },
        }),
      },
    },
  } as unknown as Env;
  await compactWithValet(env, model, REF, INFO, "s", "manual", signal);
  return summary;
}

describe("summary finish", () => {
  test("a stop finish is returned, trimmed", async () => {
    const text = await summarize(
      chunks(
        { type: "text-delta", text: "  sum" },
        { type: "text-delta", text: "mary  " },
        { type: "finish", reason: "stop" },
      ),
    );
    expect(text).toBe("summary");
  });

  test("an error finish is not stored", async () => {
    await expect(
      summarize(
        chunks({ type: "text-delta", text: "nope" }, { type: "finish", reason: "error", error: "boom" }),
      ),
    ).rejects.toThrow("boom");
  });

  test("a cancelled finish is not stored", async () => {
    await expect(
      summarize(
        chunks({ type: "text-delta", text: "partial summary" }, { type: "finish", reason: "cancelled" }),
      ),
    ).rejects.toThrow("summary cancelled");
  });

  test("a length finish is not stored", async () => {
    await expect(
      summarize(chunks({ type: "text-delta", text: "cut off mid" }, { type: "finish", reason: "length" })),
    ).rejects.toThrow("summary truncated");
  });

  test("no finish chunk is not stored", async () => {
    await expect(summarize(chunks({ type: "text-delta", text: "looks done" }))).rejects.toThrow(
      "summary ended without a finish chunk",
    );
  });

  test("an aborted signal is not stored and does not start the stream", async () => {
    const ac = new AbortController();
    ac.abort();
    let streamed = false;
    const model = {
      kind: "model",
      async *stream() {
        streamed = true;
        yield { type: "text-delta", text: "nope" };
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as ModelProvider;
    const env = {
      ctx: {
        scopes: {
          get: () => ({
            compact: async (req: { summarize(transcript: string): Promise<string> }) => {
              await req.summarize("TRANSCRIPT");
            },
          }),
        },
      },
    } as unknown as Env;
    await expect(compactWithValet(env, model, REF, INFO, "s", "manual", ac.signal)).rejects.toThrow(
      "summary cancelled",
    );
    expect(streamed).toBe(false);
  });

  test("aborting during the summary stream drops the partial text", async () => {
    const ac = new AbortController();
    const model = {
      kind: "model",
      async *stream() {
        yield { type: "text-delta", text: "half a summary" };
        ac.abort();
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as ModelProvider;
    const env = {
      ctx: {
        scopes: {
          get: () => ({
            compact: async (req: { summarize(transcript: string): Promise<string> }) => {
              await req.summarize("TRANSCRIPT");
            },
          }),
        },
      },
    } as unknown as Env;
    await expect(compactWithValet(env, model, REF, INFO, "s", "auto", ac.signal)).rejects.toThrow(
      "summary cancelled",
    );
  });
});

interface Invoked {
  callId: string;
  input: unknown;
}

function modelHarness(opts: {
  signal?: AbortSignal;
  tools?: {
    name: string;
    invoke: (
      input: unknown,
      call: { callId: string; signal: AbortSignal },
    ) => Promise<{
      content: { type: "text"; text: string }[];
      isError?: boolean;
    }>;
  }[];
  emit?: (input: unknown) => unknown;
  shouldCompact?: () => boolean;
  compact?: (summarize: (transcript: string) => Promise<string>) => Promise<void>;
}) {
  const notices: string[] = [];
  const ended: string[] = [];
  const signal = opts.signal ?? new AbortController().signal;
  const env = {
    ctx: {
      scopes: {
        get: () => ({
          build: async () => ({
            system: "sys",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            estimatedTokens: 1,
            files: [],
          }),
          shouldCompact: async () => opts.shouldCompact?.() ?? false,
          compact: async (req: { summarize(transcript: string): Promise<string> }) => {
            if (opts.compact) await opts.compact(req.summarize);
          },
        }),
        all: () => [
          {
            impl: {
              list: async () =>
                (opts.tools ?? []).map((tool) => ({
                  name: tool.name,
                  description: tool.name,
                  inputSchema: {},
                  invoke: tool.invoke,
                })),
            },
          },
        ],
      },
      events: {
        emit: async (_name: string, payload: { input: unknown }) => ({
          payload: { ...payload, input: opts.emit ? opts.emit(payload.input) : payload.input },
          cancelled: false,
        }),
      },
    },
    ownTools: () => [],
  } as unknown as Env;
  const rc = {
    sessionId: "s",
    projectId: "p",
    cwd: "/tmp",
    runId: "r",
    role: "owner",
    caller: { plugin: "valet-agent" },
    signal,
    parts: {
      text() {},
      start() {},
      update() {},
      end(callId: string) {
        ended.push(callId);
      },
      files() {},
      notice(_level: string, text: string) {
        notices.push(text);
      },
    },
    usage() {},
  } as unknown as RunCtx;
  return { env, rc, notices, ended };
}

describe("model run", () => {
  test("abort during auto-compaction cancels the run", async () => {
    const ac = new AbortController();
    const { env, rc } = modelHarness({
      signal: ac.signal,
      shouldCompact: () => true,
      compact: async () => {
        ac.abort();
      },
    });
    const model = {
      kind: "model",
      async *stream() {
        yield { type: "text-delta", text: "answer" };
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as ModelProvider;
    expect(await runModel(env, model, REF, rc, INFO)).toEqual({ status: "cancelled" });
  });

  test("a truncated auto-compaction is a warning and the run still stops", async () => {
    let stored: string | undefined;
    const { env, rc, notices } = modelHarness({
      shouldCompact: () => true,
      compact: async (summarize) => {
        stored = await summarize("TRANSCRIPT");
      },
    });
    let n = 0;
    const model = {
      kind: "model",
      async *stream() {
        n += 1;
        if (n === 1) {
          yield { type: "text-delta", text: "answer" };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "text-delta", text: "cut off mid" };
        yield { type: "finish", reason: "length" };
      },
    } as unknown as ModelProvider;
    expect(await runModel(env, model, REF, rc, INFO)).toEqual({ status: "stop" });
    expect(stored).toBeUndefined();
    expect(notices).toEqual(["Auto-compaction failed: summary truncated"]);
  });

  test("does not stream when the run is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let streams = 0;
    const { env, rc } = modelHarness({ signal: ac.signal });
    const model = {
      kind: "model",
      async *stream() {
        streams += 1;
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as ModelProvider;
    expect(await runModel(env, model, REF, rc, INFO)).toEqual({ status: "cancelled" });
    expect(streams).toBe(0);
  });

  test("does not run a later tool call after the run is aborted", async () => {
    const ac = new AbortController();
    const invoked: Invoked[] = [];
    let streams = 0;
    const { env, rc, ended } = modelHarness({
      signal: ac.signal,
      tools: [
        {
          name: "echo",
          invoke: async (input, call) => {
            invoked.push({ callId: call.callId, input });
            if (call.callId === "t1") ac.abort();
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      ],
    });
    const model = {
      kind: "model",
      async *stream() {
        streams += 1;
        yield { type: "tool-call", callId: "t1", name: "echo", input: { n: 1 } };
        yield { type: "tool-call", callId: "t2", name: "echo", input: { n: 2 } };
        yield { type: "finish", reason: "tool-calls" };
      },
    } as unknown as ModelProvider;
    expect(await runModel(env, model, REF, rc, INFO)).toEqual({ status: "cancelled" });
    expect(invoked.map((call) => call.callId)).toEqual(["t1"]);
    expect(ended).toEqual(["t1"]);
    expect(streams).toBe(1);
  });

  test("assistant content keeps stream order and the gated tool input", async () => {
    const invoked: unknown[] = [];
    const requests: ModelMessage[][] = [];
    const { env, rc } = modelHarness({
      tools: [
        {
          name: "echo",
          invoke: async (input) => {
            invoked.push(input);
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      ],
      emit: (input) => {
        const body = input as { rewrite?: boolean };
        return body.rewrite === true ? { rewritten: true } : input;
      },
    });
    let n = 0;
    const model = {
      kind: "model",
      async *stream(req: { messages: ModelMessage[] }) {
        requests.push(req.messages);
        n += 1;
        if (n > 1) {
          yield { type: "text-delta", text: "done" };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "text-delta", text: "be" };
        yield { type: "reasoning-delta", text: "thinking" };
        yield { type: "text-delta", text: "fore" };
        yield { type: "tool-call", callId: "t1", name: "echo", input: { rewrite: true } };
        yield { type: "text-delta", text: "mid" };
        yield { type: "tool-call", callId: "t2", name: "echo", input: { n: 2 } };
        yield { type: "text-delta", text: "after" };
        yield { type: "finish", reason: "tool-calls" };
      },
    } as unknown as ModelProvider;
    expect(await runModel(env, model, REF, rc, INFO)).toEqual({ status: "stop" });
    expect(invoked).toEqual([{ rewritten: true }, { n: 2 }]);
    const assistant = requests[1]?.find((message) => message.role === "assistant");
    expect(assistant).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        { type: "tool-call", callId: "t1", name: "echo", input: { rewritten: true } },
        { type: "text", text: "mid" },
        { type: "tool-call", callId: "t2", name: "echo", input: { n: 2 } },
        { type: "text", text: "after" },
      ],
    });
  });
});

function setupAgent(prompt: () => AsyncIterable<AgentEvent>, signal = new AbortController().signal) {
  const chat: PartData[] = [];
  const ends: { status: string; error?: string }[] = [];
  const env = {
    ctx: {
      scopes: {
        get: () => ({
          compactionStart: async (req: { by: string }) => {
            chat.push({ type: "compaction", by: req.by, status: "in_progress", coversThroughSeq: 0 });
            return { compactionId: "c1" };
          },
          compactionEnd: async (req: { status: "completed" | "failed" | "cancelled"; error?: string }) => {
            ends.push({ status: req.status, ...(req.error ? { error: req.error } : {}) });
            const open = chat.findLast((part) => part.type === "compaction" && part.status === "in_progress");
            if (open?.type === "compaction")
              Object.assign(open, { status: req.status, ...(req.error ? { error: req.error } : {}) });
          },
        }),
      },
    },
    agents: {
      acquire: async () => ({
        providerId: "p",
        model: "m",
        needsPreamble: false,
        notedCompactions: 0,
        session: { prompt },
      }),
    },
    tools: { async enter() {}, leave() {} },
  } as unknown as Env;
  const rc = {
    sessionId: "s",
    content: [{ type: "text", text: "hi" }],
    signal,
    store: { messages: { list: () => [] } },
    parts: { text() {}, start() {}, update() {}, end() {}, notice() {}, files() {} },
    usage() {},
  } as unknown as RunCtx;
  return {
    chat,
    ends,
    run: () => runAgent(env, provider, REF, rc, INFO),
  };
}

describe("agent run", () => {
  test("an aborted run is cancelled for every finish reason", async () => {
    for (const reason of ["stop", "length", "error"] as const) {
      const ac = new AbortController();
      const { run } = setupAgent(async function* () {
        yield { type: "text-delta", text: "x" };
        ac.abort();
        yield reason === "error" ? { type: "finish", reason, error: "boom" } : { type: "finish", reason };
      }, ac.signal);
      expect(await run()).toEqual({ status: "cancelled" });
    }
  });

  test("a finish of cancelled is cancelled even when the signal is still live", async () => {
    const { run } = setupAgent(async function* () {
      yield { type: "finish", reason: "cancelled" };
    });
    expect(await run()).toEqual({ status: "cancelled" });
  });

  test("a prompt that ends without a finish event is an error", async () => {
    const { run } = setupAgent(async function* () {
      yield { type: "text-delta", text: "dangling" };
    });
    expect(await run()).toEqual({ status: "error", error: "agent stream ended without a finish event" });
  });

  test("a prompt that ends without a finish event while aborted is cancelled", async () => {
    const ac = new AbortController();
    const { run } = setupAgent(async function* () {
      yield { type: "text-delta", text: "dangling" };
      ac.abort();
    }, ac.signal);
    expect(await run()).toEqual({ status: "cancelled" });
  });

  test("a live finish stop still completes", async () => {
    const { run } = setupAgent(async function* () {
      yield { type: "finish", reason: "stop" };
    });
    expect(await run()).toEqual({ status: "stop" });
  });

  test("a finish error is still an error", async () => {
    const { run } = setupAgent(async function* () {
      yield { type: "finish", reason: "error", error: "boom" };
    });
    expect(await run()).toEqual({ status: "error", error: "boom" });
  });

  test("a prompt that throws mid-compaction closes the part", async () => {
    const { run, chat } = setupAgent(async function* () {
      yield { type: "compaction-start" };
      throw new Error("prompt blew up");
    });
    await expect(run()).rejects.toThrow("prompt blew up");
    expect(chat[0]).toMatchObject({
      status: "failed",
      error: "the turn ended before the compaction finished",
    });
  });

  test("an aborted finish closes an open compaction as cancelled", async () => {
    const ac = new AbortController();
    const { run, chat, ends } = setupAgent(async function* () {
      yield { type: "compaction-start" };
      ac.abort();
      yield { type: "finish", reason: "stop" };
    }, ac.signal);
    expect(await run()).toEqual({ status: "cancelled" });
    expect(chat[0]).toMatchObject({ status: "cancelled" });
    expect(ends).toEqual([{ status: "cancelled", error: "the turn ended before the compaction finished" }]);
  });

  test("a completed compaction is not closed again when the turn finishes", async () => {
    const { run, chat, ends } = setupAgent(async function* () {
      yield { type: "compaction-start" };
      yield { type: "compaction-end", status: "completed" };
      yield { type: "finish", reason: "stop" };
    });
    expect(await run()).toEqual({ status: "stop" });
    expect(chat[0]).toMatchObject({ status: "completed" });
    expect(ends).toEqual([{ status: "completed" }]);
  });
});

describe("compaction recorder", () => {
  test("a failed end stays open and can be retried", async () => {
    let calls = 0;
    const ctx = {
      scopes: {
        get: () => ({
          compactionStart: async () => ({ compactionId: "c1" }),
          compactionEnd: async () => {
            calls += 1;
            if (calls === 1) throw new Error("end failed");
          },
        }),
      },
    } as unknown as Env["ctx"];
    const recorder = new CompactionRecorder(ctx, "s", "Fake");
    await recorder.start();
    await expect(recorder.end("completed")).rejects.toThrow("end failed");
    expect(recorder.open).toBe(true);
    await recorder.end("cancelled");
    expect(recorder.open).toBe(false);
    expect(calls).toBe(2);
  });

  test("a harness compact that throws closes the marker", async () => {
    const chat: PartData[] = [];
    const env = {
      ctx: {
        signal: new AbortController().signal,
        scopes: {
          get: () => ({
            compactionStart: async (req: { by: string }) => {
              chat.push({ type: "compaction", by: req.by, status: "in_progress", coversThroughSeq: 0 });
              return { compactionId: "c1" };
            },
            compactionEnd: async (req: { status: "failed"; error?: string }) => {
              const open = chat.findLast(
                (part) => part.type === "compaction" && part.status === "in_progress",
              );
              if (open?.type === "compaction")
                Object.assign(open, { status: req.status, ...(req.error ? { error: req.error } : {}) });
            },
          }),
        },
      },
      agents: {
        acquire: async () => ({
          session: {
            async *compact() {
              yield { type: "compaction-start" };
              throw new Error("compact blew up");
            },
          },
        }),
      },
    } as unknown as Env;
    await expect(compactHarness(env, provider, REF, INFO, "s", "/tmp", undefined)).rejects.toThrow(
      "compact blew up",
    );
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ status: "failed" });
  });

  test("a harness compact that completes is not marked failed afterwards", async () => {
    const chat: PartData[] = [];
    const ends: string[] = [];
    const env = {
      ctx: {
        signal: new AbortController().signal,
        scopes: {
          get: () => ({
            compactionStart: async (req: { by: string }) => {
              chat.push({ type: "compaction", by: req.by, status: "in_progress", coversThroughSeq: 0 });
              return { compactionId: "c1" };
            },
            compactionEnd: async (req: { status: "completed" | "failed" | "cancelled"; error?: string }) => {
              ends.push(req.status);
              const open = chat.findLast(
                (part) => part.type === "compaction" && part.status === "in_progress",
              );
              if (open?.type === "compaction")
                Object.assign(open, { status: req.status, ...(req.error ? { error: req.error } : {}) });
            },
          }),
        },
      },
      agents: {
        acquire: async () => ({
          session: {
            async *compact() {
              yield { type: "compaction-end", status: "completed" };
              yield { type: "finish", reason: "stop" };
            },
          },
        }),
      },
    } as unknown as Env;
    expect(await compactHarness(env, provider, REF, INFO, "s", "/tmp", undefined)).toEqual({});
    expect(chat[0]).toMatchObject({ status: "completed" });
    expect(ends).toEqual(["completed"]);
  });
});
