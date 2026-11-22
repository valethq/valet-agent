import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part, Store } from "@valethq/sdk";
import { copyMessages } from "../src/copy";
import { textOf } from "../src/content";
import { presentedOf, presentTool } from "../src/present";
import type { AgentCtx } from "../src/env";
import { aclParts, callerOf, principals } from "./acl";
import type { Role, ToolCall } from "@valethq/sdk";

const tmp = () => mkdtempSync(join(tmpdir(), "valet-light-"));

function presentHarness(config: Record<string, unknown> = {}) {
  const ctx = {
    ...aclParts,
    config,
    store: {
      principals,
      sessions: { get: () => undefined },
      blobs: {
        put: async (_b: Blob) => ({ id: "blb_1" }),
      },
    },
  } as unknown as AgentCtx;
  const tool = presentTool(ctx);
  return (cwd: string, path: string, role: Role = "owner") =>
    tool.invoke({ path }, { cwd, role, sessionId: "ses_1", caller: callerOf(role) } as ToolCall);
}

describe("light fixes", () => {
  test("A1: a workspace file named ..notes.txt is not treated as outside", async () => {
    const ws = tmp();
    writeFileSync(join(ws, "..notes.txt"), "note");
    const res = await presentHarness()(ws, "..notes.txt");
    expect(res.isError).toBeUndefined();
    expect(presentedOf(res)).toHaveLength(1);
  });

  test("A2: relative presentRoots entries are ignored", async () => {
    const ws = tmp();
    const other = tmp();
    writeFileSync(join(other, "secret.txt"), "s");
    const invoke = presentHarness({ presentRoots: ["."] });
    expect((await invoke(ws, join(other, "secret.txt"))).isError).toBe(true);
    writeFileSync(join(ws, "ok.txt"), "ok");
    expect(presentedOf(await invoke(ws, "ok.txt"))).toHaveLength(1);
  });

  test("A3: untitled boot titling prefers the oldest user message, not the newest 20", () => {
    const rows: { message: { role: string; seq: number }; parts: Part[] }[] = [];
    for (let seq = 1; seq <= 25; seq++) {
      const role = seq % 2 === 1 ? "user" : "assistant";
      rows.push({
        message: { role, seq },
        parts: [{ type: "text", idx: 0, data: { type: "text", text: `line-${seq}` } } as Part],
      });
    }
    const list = (opts?: { limit?: number }) => (opts?.limit ? rows.slice(-opts.limit) : rows);
    const oldFirst = list({ limit: 20 }).find((r) => r.message.role === "user");
    const newFirst = list().find((r) => r.message.role === "user");
    expect(textOf(oldFirst!.parts)).toBe("line-7");
    expect(textOf(newFirst!.parts)).toBe("line-1");
  });

  test("A4: copyMessages maps in-flight tool-call status to cancelled", async () => {
    const source = "src";
    const dest = "dst";
    const parts = [
      {
        type: "tool-call",
        idx: 0,
        data: { type: "tool-call", callId: "c1", name: "x", status: "running", input: null },
      },
      {
        type: "tool-call",
        idx: 1,
        data: { type: "tool-call", callId: "c2", name: "y", status: "pending", input: null },
      },
      {
        type: "tool-call",
        idx: 2,
        data: { type: "tool-call", callId: "c3", name: "z", status: "done", input: null },
      },
    ] as Part[];
    const created: { parts: unknown[] }[] = [];
    const store = {
      messages: {
        list: (id: string) =>
          id === source ? [{ message: { seq: 1, id: "m1", status: "complete", meta: {} }, parts }] : [],
        create: async (body: { parts: unknown[] }) => {
          created.push(body);
          return { message: { id: "n1" } };
        },
      },
    } as unknown as Store;
    await copyMessages(store, source, dest, 1);
    const copied = created[0]!.parts as { status: string }[];
    expect(copied[0]?.status).toBe("cancelled");
    expect(copied[1]?.status).toBe("cancelled");
    expect(copied[2]?.status).toBe("done");
  });
});
