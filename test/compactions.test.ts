import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentProvider, ModelInfo, ModelProvider, PartData } from "@valethq/sdk";
import { runAgent } from "../src/agent-run";
import type { AgentEntry } from "../src/agents";
import { autoCompact, compactWithValet } from "../src/compactions";
import type { Env } from "../src/env";
import type { RunCtx } from "../src/run-types";

const chat: PartData[] = [];
const prompts: { type: string; text?: string }[][] = [];
const events: AgentEvent[] = [{ type: "finish", reason: "stop" }];
const compacts: Record<string, unknown>[] = [];

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
  ctx: {
    scopes: {
      get: () => ({
        compact: async (req: { by: { kind: string; label?: string } }) => {
          compacts.push(req);
          chat.push({ type: "compaction", by: req.by.label ?? "valet", coversThroughSeq: 0 });
        },
      }),
    },
  },
  agents: { acquire: async () => entry },
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
const harness = (by: string): PartData => ({ type: "compaction", by, coversThroughSeq: 0 });

describe("compaction note", () => {
  test("prepended once for harness compactions, repeated only for new ones", async () => {
    chat.push(harness("Devin CLI"), {
      type: "compaction",
      by: "valet",
      coversThroughSeq: 0,
      summary: "earlier",
    });
    await run();
    expect(last()).toHaveLength(2);
    expect(last()[0]?.text).toBe(
      "[valet: Devin CLI compacted your context 1 time(s) in this chat. Turns before the latest compaction reach you only as its summary, so quote them from the summary with that caveat. This is still the same chat, not a new thread.]",
    );
    expect(last()[1]?.text).toBe("hi");

    await run();
    expect(last()).toEqual([{ type: "text", text: "hi" }]);

    chat.push(harness("Claude Code"));
    await run();
    expect(last()[0]?.text).toContain("Devin CLI, Claude Code compacted your context 2 time(s)");
    expect(entry.notedCompactions).toBe(2);
  });

  test("a compaction event marks the chat and is reported on the next turn", async () => {
    events.unshift({ type: "compaction" });
    await run();
    expect(last()[0]?.text).toBe("hi");
    expect(compacts.at(-1)).toEqual({
      sessionId: "s",
      reason: "auto",
      by: { kind: "harness", label: "Fake agent" },
    });
    events.shift();
    await run();
    expect(last()[0]?.text).toContain("3 time(s)");
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
            compact: async (req: { by: { summarize(t: string): Promise<string> } }) =>
              summaries.push(await req.by.summarize("TRANSCRIPT")),
          }),
        },
      },
    } as unknown as Env;

    await compactWithValet(valetEnv, modelProvider, "m1", "s", "manual", new AbortController().signal);
    expect(summaries).toEqual(["summary"]);
    expect(calls[0]?.model).toBe("m1");
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
    await autoCompact(failingEnv, {} as ModelProvider, { id: "m1" } as ModelInfo, runCtx, 900);
    expect(warnings).toEqual(["Auto-compaction failed: boom"]);
  });
});
