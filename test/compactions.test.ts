import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentProvider, ModelInfo } from "@valethq/sdk";
import { runAgent } from "../src/agent-run";
import type { AgentEntry } from "../src/agents";
import type { Env } from "../src/env";
import type { RunCtx } from "../src/run-types";

const notices: string[] = [];
const prompts: { type: string; text?: string }[][] = [];
const events: AgentEvent[] = [{ type: "finish", reason: "stop" }];

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

const env = { ctx: {}, agents: { acquire: async () => entry } } as unknown as Env;
const store = {
  messages: {
    list: () => [
      { message: {}, parts: [{ data: { type: "text", text: "Context compacted by user" } }] },
      { message: {}, parts: notices.map((text) => ({ data: { type: "notice", level: "info", text } })) },
    ],
  },
};
const rc = {
  sessionId: "s",
  content: [{ type: "text", text: "hi" }],
  signal: new AbortController().signal,
  store,
  parts: { notice: (_l: string, text: string) => notices.push(text) },
} as unknown as RunCtx;
const provider = { id: "p" } as AgentProvider;
const run = () => runAgent(env, provider, { provider: "p", model: "m" }, rc, { id: "m" } as ModelInfo);
const last = () => prompts[prompts.length - 1] ?? [];

describe("compaction note", () => {
  test("prepended once for stored compactions, repeated only for new ones", async () => {
    notices.push("Context compacted by Devin CLI: 2k → 1k tokens", "unrelated notice");
    await run();
    expect(last()).toHaveLength(2);
    expect(last()[0]?.text).toBe(
      "[valet: Devin CLI has compacted your context 1 time(s) in this chat (Context compacted by Devin CLI: 2k → 1k tokens). Turns before the latest compaction reach you only as Devin CLI's summary, so quote them from the summary with that caveat. This is still the same chat, not a new thread.]",
    );
    expect(last()[1]?.text).toBe("hi");

    await run();
    expect(last()).toEqual([{ type: "text", text: "hi" }]);

    notices.push("Context compacted by Devin CLI: 3k → 1k tokens");
    await run();
    expect(last()[0]?.text).toContain("2 time(s)");
    expect(last()[0]?.text).toContain("tokens; Context compacted");
    expect(entry.notedCompactions).toBe(2);
  });

  test("a notice arriving mid-run is reported on the next turn", async () => {
    events.unshift({ type: "notice", level: "info", text: "Context compacted by Devin CLI: 4k → 1k tokens" });
    await run();
    expect(last()[0]?.text).toBe("hi");
    events.shift();
    await run();
    expect(last()[0]?.text).toContain("3 time(s)");
  });
});
