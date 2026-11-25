import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentProvider, ModelInfo, ModelProvider, PartData } from "@valethq/sdk";
import { runAgent } from "../src/agent-run";
import type { AgentEntry } from "../src/agents";
import { autoCompact, compactHarness, compactWithValet, CompactionRecorder } from "../src/compactions";
import type { Env } from "../src/env";
import type { RunCtx } from "../src/run-types";

const chat: PartData[] = [];
const prompts: { type: string; text?: string }[][] = [];
let events: AgentEvent[] = [{ type: "finish", reason: "stop" }];
const contextCalls: { op: string; req: Record<string, unknown> }[] = [];

const context = {
  compactionStart: async (req: { by: string }) => {
    contextCalls.push({ op: "start", req });
    chat.push({ type: "compaction", by: req.by, status: "in_progress", coversThroughSeq: 0 });
    return { compactionId: `c${contextCalls.length}` };
  },
  compactionEnd: async (req: { status: "completed" | "failed" | "cancelled"; error?: string }) => {
    contextCalls.push({ op: "end", req });
    const open = chat.findLast((p) => p.type === "compaction" && p.status === "in_progress");
    if (open?.type === "compaction")
      Object.assign(open, { status: req.status, ...(req.error ? { error: req.error } : {}) });
  },
};

const entry = {
  providerId: "p",
  model: "m",
  needsPreamble: false,
  notedCompactions: 0,
  session: {
    async *prompt(input: { content: { type: string; text?: string }[] }) {
      prompts.push(input.content);
      yield* events;
    },
  },
} as unknown as AgentEntry;

const env = {
  ctx: { scopes: { get: () => context } },
  agents: { acquire: async () => entry },
  tools: { async enter() {}, leave() {} },
} as unknown as Env;
const store = {
  messages: { list: () => chat.map((data) => ({ message: {}, parts: [{ data }] })) },
};
const rc = {
  sessionId: "s",
  content: [{ type: "text", text: "hi" }],
  signal: new AbortController().signal,
  store,
  parts: {},
} as unknown as RunCtx;
const provider = { id: "p", label: "Fake agent" } as AgentProvider;
const run = () => runAgent(env, provider, { provider: "p", model: "m" }, rc, { id: "m" } as ModelInfo);
const last = () => prompts[prompts.length - 1] ?? [];
const compaction = (by: string, status: "in_progress" | "completed" | "failed" | "cancelled"): PartData => ({
  type: "compaction",
  by,
  status,
  coversThroughSeq: 0,
});

describe("compaction note", () => {
  test("prepended once for completed harness compactions, repeated only for new ones", async () => {
    chat.push(
      compaction("Devin CLI", "completed"),
      { type: "compaction", by: "valet", status: "completed", coversThroughSeq: 0, summary: "earlier" },
      compaction("Claude Code", "in_progress"),
    );
    await run();
    expect(last()).toHaveLength(2);
    expect(last()[0]?.text).toBe(
      "[valet: Devin CLI compacted your context 1 time(s) in this chat. Turns before the latest compaction reach you only as its summary, so quote them from the summary with that caveat. This is still the same chat, not a new thread.]",
    );
    expect(last()[1]?.text).toBe("hi");

    await run();
    expect(last()).toEqual([{ type: "text", text: "hi" }]);

    chat.push(compaction("Claude Code", "completed"));
    await run();
    expect(last()[0]?.text).toContain("Devin CLI, Claude Code compacted your context 2 time(s)");
    expect(entry.notedCompactions).toBe(2);

    chat.push(compaction("Claude Code", "completed"), compaction("Claude Code", "completed"));
    await run();
    expect(last()[0]?.text).toContain("Devin CLI, Claude Code compacted your context 4 time(s)");
    expect(last()[0]?.text).not.toContain("Claude Code, Claude Code");
  });

  test("start and end events open and close a compaction part during the turn", async () => {
    chat.length = 0;
    events = [
      { type: "compaction-start" },
      { type: "compaction-end", status: "completed" },
      { type: "finish", reason: "stop" },
    ];
    await run();
    events = [{ type: "finish", reason: "stop" }];
    expect(contextCalls.map((c) => c.op)).toEqual(["start", "end"]);
    expect(contextCalls[0]?.req).toEqual({ sessionId: "s", by: "Fake agent" });
    expect(chat[0]).toMatchObject({ status: "completed", by: "Fake agent" });
  });

  test("a turn that ends mid-compaction closes the part as failed", async () => {
    chat.length = 0;
    events = [{ type: "compaction-start" }, { type: "finish", reason: "stop" }];
    await run();
    events = [{ type: "finish", reason: "stop" }];
    expect(chat[0]).toMatchObject({
      status: "failed",
      error: "the turn ended before the compaction finished",
    });
  });
});

describe("recorder", () => {
  test("end without an open part does nothing; start is idempotent", async () => {
    chat.length = 0;
    contextCalls.length = 0;
    const recorder = new CompactionRecorder(env.ctx, "s", "Claude Code");
    await recorder.end("completed");
    expect(contextCalls).toEqual([]);
    await recorder.start();
    await recorder.start();
    expect(contextCalls.filter((c) => c.op === "start")).toHaveLength(1);
    await recorder.end("completed");
    expect(recorder.open).toBe(false);
  });
});

const REF = { provider: "p", model: "m" };
const INFO: ModelInfo = {
  id: "m",
  name: "m",
  contextWindow: 1000,
  maxOutputTokens: 100,
  input: ["text"],
  reasoning: false,
};

describe("compactHarness", () => {
  const harness = (session: unknown) =>
    ({ ...env, agents: { acquire: async () => ({ session }) } }) as unknown as Env;

  test("/compact on a harness reports completed when the harness reports it", async () => {
    chat.length = 0;
    const session = {
      async *compact(instructions: string | undefined) {
        expect(instructions).toBe("keep the todo list");
        yield { type: "compaction-start" };
        yield { type: "compaction-end", status: "completed" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const reply = await compactHarness(
      harness(session),
      provider,
      REF,
      INFO,
      "s",
      "/tmp",
      "keep the todo list",
    );
    expect(reply).toEqual({});
    expect(chat[0]).toMatchObject({ status: "completed", by: "Fake agent" });
  });

  test("a harness without compact gets a plain refusal, no marker", async () => {
    chat.length = 0;
    const reply = await compactHarness(harness({}), provider, REF, INFO, "s", "/tmp", undefined);
    expect(reply).toEqual({
      text: "Fake agent can't be asked to compact. It compacts on its own when it needs to.",
      unsupported: true,
    });
    expect(chat).toEqual([]);
  });

  test("a harness error closes the marker as failed and says why", async () => {
    chat.length = 0;
    const session = {
      async *compact() {
        yield { type: "finish", reason: "error", error: "no such command" };
      },
    };
    const reply = await compactHarness(harness(session), provider, REF, INFO, "s", "/tmp", undefined);
    expect(reply).toEqual({ text: "Compaction failed: no such command" });
    expect(chat[0]).toMatchObject({ status: "failed", error: "no such command" });
  });
});

describe("valet compaction", () => {
  test("valet summarizes with the session's model and hands the summary to contextmanager", async () => {
    const calls: { model: string; messages: { content: { text: string }[] }[] }[] = [];
    const modelProvider = {
      kind: "model",
      async *stream(req: (typeof calls)[number]) {
        calls.push(req);
        yield { type: "text-delta", text: "sum" };
        yield { type: "text-delta", text: "mary" };
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as ModelProvider;
    const summaries: string[] = [];
    const valetEnv = {
      ctx: {
        scopes: {
          get: () => ({
            compact: async (req: { summarize(t: string): Promise<string> }) =>
              summaries.push(await req.summarize("TRANSCRIPT")),
          }),
        },
      },
    } as unknown as Env;

    const ref = { provider: "p", model: "m1", effort: "high", fast: true };
    const info = { ...INFO, id: "m1", efforts: ["low", "high"] };
    await compactWithValet(valetEnv, modelProvider, ref, info, "s", "manual", new AbortController().signal);
    expect(summaries).toEqual(["summary"]);
    expect(calls[0]).toMatchObject({ model: "m1", effort: "high" });
    expect(calls[0]).not.toHaveProperty("fast");
    expect(calls[0]?.messages[0]?.content[0]?.text).toBe("TRANSCRIPT");
  });

  test("an auto-compaction failure is a warning in the chat, not a failed run", async () => {
    const warnings: string[] = [];
    const failingEnv = {
      ctx: {
        scopes: {
          get: () => ({
            shouldCompact: async () => true,
            compact: async () => {
              throw new Error("boom");
            },
          }),
        },
      },
    } as unknown as Env;
    const runCtx = {
      sessionId: "s",
      signal: new AbortController().signal,
      parts: { notice: (_level: string, text: string) => warnings.push(text) },
    } as unknown as RunCtx;
    await autoCompact(failingEnv, {} as ModelProvider, REF, { id: "m1" } as ModelInfo, runCtx, 900);
    expect(warnings).toEqual(["Auto-compaction failed: boom"]);
  });
});
