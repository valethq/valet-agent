import { describe, expect, test } from "bun:test";
import type { ModelInfo, ModelProvider, PartData, Store } from "@valethq/sdk";
import type { Env } from "../src/env";
import { runModel } from "../src/model-run";
import { PartStream } from "../src/parts";
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

function partStore() {
  const live = new Map<string, Extract<PartData, { type: "tool-call" }>>();
  const store = {
    messages: {
      openPart: (_id: string, data: PartData) => {
        if (data.type !== "tool-call") throw new Error("expected tool-call");
        live.set(data.callId, { ...data });
        const callId = data.callId;
        return {
          append() {},
          replace(next: PartData) {
            if (next.type !== "tool-call") throw new Error("expected tool-call");
            live.set(callId, { ...next });
          },
          close(_outcome: string, final?: PartData) {
            if (final?.type === "tool-call") live.set(callId, { ...final });
          },
        };
      },
    },
  };
  return { store: store as unknown as Store, live };
}

describe("parts fixes", () => {
  test("PartStream.update can rewrite tool-call input", async () => {
    const { store, live } = partStore();
    const parts = new PartStream(store, async () => "m1");
    parts.start({ callId: "t1", name: "echo", input: { raw: true }, status: "pending" });
    parts.update("t1", { status: "running", input: { rewritten: true } });
    await parts.finish();
    expect(live.get("t1")).toMatchObject({ input: { rewritten: true }, status: "running" });
  });

  test("tool.call rewrite updates the stored tool-call part input", async () => {
    const { store, live } = partStore();
    const parts = new PartStream(store, async () => "m1");
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
            shouldCompact: async () => false,
          }),
          all: () => [
            {
              impl: {
                list: async () => [
                  {
                    name: "echo",
                    description: "echo",
                    inputSchema: {},
                    invoke: async () => ({ content: [{ type: "text", text: "ok" }] }),
                  },
                ],
              },
            },
          ],
        },
        events: {
          emit: async (_name: string, payload: { input: unknown }) => ({
            payload: { ...payload, input: { rewritten: true } },
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
      signal: new AbortController().signal,
      parts,
      usage() {},
    } as unknown as RunCtx;
    let n = 0;
    const model = {
      kind: "model",
      async *stream() {
        n += 1;
        if (n > 1) {
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield { type: "tool-call", callId: "t1", name: "echo", input: { rewrite: true } };
        yield { type: "finish", reason: "tool-calls" };
      },
    } as unknown as ModelProvider;
    expect(await runModel(env, model, REF, rc, INFO)).toEqual({ status: "stop" });
    expect(live.get("t1")?.input).toEqual({ rewritten: true });
  });
});
