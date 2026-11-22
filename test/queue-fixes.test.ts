import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, Store, ToolCall } from "@valethq/sdk";
import type { Catalog } from "../src/catalog";
import type { AgentCtx } from "../src/env";
import { historyNote } from "../src/history";
import type { AgentConfig } from "../src/model";
import type { RunQueue } from "../src/queue";
import { execute, type Job } from "../src/runner";
import { subagentTool } from "../src/subagent";
import { openAcl } from "./acl";
import { type Json, type Kernel, startKernel, waitFor } from "./kernel";

describe("historyNote", () => {
  const note = (
    entries: { message: { seq: number; role: string }; parts: { data: Record<string, unknown> }[] }[],
  ) => {
    const store = {
      messages: {
        list: (_id: string, q?: { beforeSeq?: number }) =>
          entries.filter((e) => q?.beforeSeq === undefined || e.message.seq < q.beforeSeq),
      },
      partTypes: { get: () => undefined },
    } as unknown as Store;
    const content = historyNote(store, "ses", 1_000_000);
    return content?.type === "text" ? content.text : undefined;
  };

  test("keeps a tool-only assistant turn, in part order, and clips long output", () => {
    const text = note([
      { message: { seq: 1, role: "user" }, parts: [{ data: { type: "text", text: "hi" } }] },
      {
        message: { seq: 2, role: "assistant" },
        parts: [
          { data: { type: "text", text: "before" } },
          { data: { type: "reasoning", text: "SECRET_REASON" } },
          { data: { type: "tool-call", name: "echo", input: { a: 1 }, output: "one" } },
          { data: { type: "custom", kind: "x", title: "t", text: "AFTER_TEXT", data: {} } },
          { data: { type: "tool-call", name: "shell", input: { cmd: "pwd" }, output: "o".repeat(2500) } },
        ],
      },
      {
        message: { seq: 3, role: "assistant" },
        parts: [{ data: { type: "tool-call", name: "echo", input: {}, output: "only" } }],
      },
    ]);
    expect(text).toContain("User: hi");
    const body = text ?? "";
    const at = (s: string) => body.indexOf(s);
    expect(at("Assistant: before")).toBeGreaterThanOrEqual(0);
    expect(at("Assistant: before")).toBeLessThan(at('[tool echo {"a":1}: one]'));
    expect(at('[tool echo {"a":1}: one]')).toBeLessThan(at("AFTER_TEXT"));
    expect(at("AFTER_TEXT")).toBeLessThan(at("[tool shell"));
    expect(body).toContain(`: ${"o".repeat(2000)}…`);
    expect(body).not.toContain("o".repeat(2001));
    expect(body).not.toContain("SECRET_REASON");
    expect(body).toContain("Assistant: [tool echo {}: only]");
  });

  test("still drops turns already covered by a summary", () => {
    const text = note([
      {
        message: { seq: 1, role: "assistant" },
        parts: [
          { data: { type: "text", text: "OLDTEXT" } },
          {
            data: { type: "compaction", status: "completed", summary: "SUM", coversThroughSeq: 1 },
          },
        ],
      },
      {
        message: { seq: 2, role: "assistant" },
        parts: [{ data: { type: "tool-call", name: "echo", input: { a: 1 }, output: "KEEPTOOL" } }],
      },
    ]);
    expect(text).toContain("SUM");
    expect(text).toContain('[tool echo {"a":1}: KEEPTOOL]');
    expect(text).not.toContain("OLDTEXT");
    expect(text).not.toContain("[earlier turns cut]");
  });

  test("still cuts the transcript at MAX_CHARS, including tool lines", () => {
    const cut = note([
      { message: { seq: 1, role: "user" }, parts: [{ data: { type: "text", text: "EARLYMARKER" } }] },
      {
        message: { seq: 2, role: "assistant" },
        parts: [{ data: { type: "tool-call", name: "echo", input: { a: 1 }, output: "KEEPTOOL" } }],
      },
      { message: { seq: 3, role: "user" }, parts: [{ data: { type: "text", text: "T".repeat(80_000) } }] },
    ]);
    expect(cut).toContain("[earlier turns cut]");
    expect(cut).not.toContain("KEEPTOOL");
    expect(cut).not.toContain("EARLYMARKER");

    const kept = note([
      { message: { seq: 1, role: "user" }, parts: [{ data: { type: "text", text: "H".repeat(80_000) } }] },
      {
        message: { seq: 2, role: "assistant" },
        parts: [{ data: { type: "tool-call", name: "echo", input: { a: 1 }, output: "KEEPTOOL" } }],
      },
    ]);
    expect(kept).toContain("[earlier turns cut]");
    expect(kept).toContain('[tool echo {"a":1}: KEEPTOOL]');
    expect(kept).not.toContain("H".repeat(80_000));
  });

  test("nothing before the cursor yields undefined", () => {
    expect(note([])).toBeUndefined();
  });
});

describe("execute settles a run when setup or completion throws", () => {
  function envFor(failComplete: boolean) {
    const runs = new Map<string, { id: string; status: string; error?: string }>();
    const completed: string[] = [];
    let assistant: { id: string; runId: string | null; role: string; status: string } | undefined;
    const store = {
      sessions: {
        get: (id: string) => (id === "ses" ? { id, projectId: "prj", settings: {} } : undefined),
      },
      projects: { get: () => undefined },
      principals: { get: () => undefined },
      runs: {
        create: () => {
          const run = { id: "run1", status: "queued" };
          runs.set(run.id, run);
          return run;
        },
        update: (id: string, patch: { status?: string; error?: string }) => {
          const run = runs.get(id);
          if (!run) throw new Error(`missing run ${id}`);
          Object.assign(run, patch);
        },
        get: (id: string) => runs.get(id),
        caller: () => ({ plugin: "valet-agent" }),
      },
      messages: {
        create: async (m: { runId?: string }) => {
          assistant = { id: "asst", runId: m.runId ?? null, role: "assistant", status: "streaming" };
          return { message: { id: "asst" } };
        },
        openPart: () => ({ partId: "p", append() {}, replace() {}, close() {} }),
        complete: async (id: string, status: "complete" | "error" | "interrupted") => {
          completed.push(status);
          if (failComplete && completed.length === 1) throw new Error("complete refused");
          if (assistant?.id === id) assistant.status = status;
        },
        list: () => (assistant ? [{ message: { ...assistant }, parts: [] }] : []),
      },
    };
    const ctx = {
      store,
      config: {},
      signal: new AbortController().signal,
      plugin: { id: "valet-agent" },
      paths: { data: "/tmp" },
      log: { warn() {}, error() {}, info() {} },
    } as unknown as PluginContext<AgentConfig>;
    const env = {
      ctx,
      catalog: {
        normalize() {
          throw new Error("normalize blew up");
        },
      },
      lastUsage: new Map(),
    };
    const job = {
      sessionId: "ses",
      message: { id: "msg", seq: 1, authorPrincipalId: null },
      parts: [],
      role: "owner",
      subject: { principalId: null },
    } as unknown as Job;
    return { env, job, runs, completed, assistant: () => assistant };
  }

  test("normalize throwing still finishes the run as error", async () => {
    const { env, job, runs, completed, assistant } = envFor(false);
    await execute(env as never, job, { controller: new AbortController(), messageId: "msg" });
    expect(runs.get("run1")).toMatchObject({ status: "error", error: "normalize blew up" });
    expect(completed).toEqual(["error"]);
    expect(assistant()?.status).toBe("error");
  });

  test("messages.complete throwing still finishes the run and the assistant message", async () => {
    const { env, job, runs, completed, assistant } = envFor(true);
    await execute(env as never, job, { controller: new AbortController(), messageId: "msg" });
    expect(runs.get("run1")).toMatchObject({ status: "error", error: "complete refused" });
    expect(completed).toEqual(["error", "error"]);
    expect(assistant()?.status).toBe("error");
  });
});

describe("subagent abort", () => {
  function harness(opts: { active?: string; finish: boolean }) {
    const ac = new AbortController();
    const signal = ac.signal;
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, fn: () => void, options?: unknown) => {
      if (type === "abort") added.push(fn);
      return origAdd(type, fn, options as AddEventListenerOptions);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, fn: () => void, options?: unknown) => {
      if (type === "abort") removed.push(fn);
      return origRemove(type, fn, options as EventListenerOptions);
    }) as typeof signal.removeEventListener;

    const seen = { cancel: [] as string[], drop: [] as string[] };
    let notify: (f: { sessionId: string; messageId: string; runId?: string }) => void = () => {};
    const queue = {
      onFinished(fn: (f: { sessionId: string; messageId: string; runId?: string }) => void) {
        notify = fn;
        return () => {
          notify = () => {};
        };
      },
      async cancelActive(sessionId: string) {
        seen.cancel.push(sessionId);
        return true;
      },
      dropJob(sessionId: string, messageId: string) {
        seen.drop.push(`${sessionId}:${messageId}`);
        return true;
      },
      activeMessageId: () => opts.active,
    } as unknown as RunQueue;

    const sessions = new Map([
      ["parent", { id: "parent", parentSessionId: null, projectId: "p", settings: {} }],
      ["child", { id: "child", parentSessionId: "parent", projectId: "p", settings: {} }],
    ]);
    const store = {
      sessions: { get: (id: string) => sessions.get(id) },
      projects: { get: () => undefined },
      principals: { get: () => undefined },
      messages: {
        create: async () => {
          if (opts.finish) notify({ sessionId: "child", messageId: "m-task", runId: "run-child" });
          else setTimeout(() => ac.abort(), 0);
          return { message: { id: "m-task" } };
        },
        list: () => [
          {
            message: { role: "assistant", runId: "run-child" },
            parts: [{ data: { type: "text", text: "done" } }],
          },
        ],
      },
      runs: { get: (id: string) => (id === "run-child" ? { status: "complete" } : undefined) },
    } as unknown as Store;
    const ctx = {
      ...openAcl,
      config: {},
      signal: new AbortController().signal,
      store,
    } as unknown as AgentCtx;
    return { signal, added, removed, seen, queue, ctx };
  }

  async function invoke(opts: { active?: string; finish: boolean }) {
    const h = harness(opts);
    const result = await subagentTool(h.ctx, h.queue, {} as Catalog).invoke(
      { tasks: [{ prompt: "hi", session: "child" }] },
      {
        role: "owner",
        sessionId: "parent",
        runId: "run-parent",
        signal: h.signal,
        caller: { plugin: "valet-agent" },
      } as ToolCall,
    );
    return { ...h, result };
  }

  const text = (result: { content: { type: string; text?: string }[] }) =>
    result.content[0]?.type === "text" ? result.content[0].text : "";

  test("the abort listener is removed when the turn finishes", async () => {
    const { added, removed, seen, result } = await invoke({ finish: true });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("done");
    expect(added).toHaveLength(1);
    expect(removed).toContain(added[0]);
    expect(seen.cancel).toEqual([]);
    expect(seen.drop).toEqual([]);
  });

  test("abort cancels the run only when it is this task's active job", async () => {
    const { seen, result } = await invoke({ finish: false, active: "m-task" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("cancelled");
    expect(seen.cancel).toEqual(["child"]);
    expect(seen.drop).toEqual([]);
  });

  test("abort drops only this task's pending job when another run is active", async () => {
    const { seen, result } = await invoke({ finish: false, active: "someone-else" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("cancelled");
    expect(seen.cancel).toEqual([]);
    expect(seen.drop).toEqual(["child:m-task"]);
  });
});

describe("queue fixes on a kernel", () => {
  let k: Kernel;
  let projectId: string;
  const agent = { model: { provider: "fake-agent", model: "m1" } };

  beforeAll(async () => {
    k = await startKernel();
    const res = await k.api("/api/core/projects", {
      method: "POST",
      body: { name: "p", workspaceDir: mkdtempSync(join(tmpdir(), "valet-agent-ws-")) },
    });
    projectId = res.body.id;
  });
  afterAll(() => k?.stop());

  interface Entry {
    message: { id: string; role: string; status: string; runId: string | null };
    parts: { type: string; data: Record<string, Json> }[];
  }

  const newSession = async (settings: Record<string, unknown> = agent): Promise<string> =>
    (await k.api("/api/core/sessions", { method: "POST", body: { projectId, settings } })).body.id;
  const send = (sessionId: string, text: string) =>
    k.api(`/api/core/sessions/${sessionId}/messages`, {
      method: "POST",
      body: { role: "user", parts: [{ type: "text", text }] },
    });
  const messages = async (sessionId: string): Promise<Entry[]> =>
    (await k.api(`/api/core/sessions/${sessionId}/messages`)).body;
  const textOf = (e: Entry | undefined) =>
    e?.parts
      .filter((p) => p.type === "text")
      .map((p) => p.data.text)
      .join("") ?? "";
  const assistants = async (sessionId: string) =>
    (await messages(sessionId)).filter((m) => m.message.role === "assistant");
  const done = (sessionId: string, n: number) =>
    waitFor(async () => {
      const list = await assistants(sessionId);
      return list.length >= n && list.every((a) => a.message.status !== "streaming") && list;
    });
  const state = async (sessionId: string): Promise<{ activeRunId?: string; queued: number }> =>
    (await k.api(`/plugins/valet-agent/sessions/${sessionId}/state`)).body;
  const sessionStatus = async (sessionId: string) =>
    (await k.api(`/api/core/sessions/${sessionId}`)).body.status as string;
  const log = async (): Promise<Record<string, Json>[]> =>
    (await fetch(`${k.base}/plugins/valet-fixture-inference/log`).then((r) => r.json())) as Record<
      string,
      Json
    >[];
  const arm = (sessionId: string, mode: "deny" | "throw") =>
    k.api("/plugins/valet-fixture-queuefix/arm", { method: "POST", body: { sessionId, mode } });
  const childrenOf = async (parent: string): Promise<{ id: string }[]> =>
    (await k.api(`/api/core/sessions?projectId=${projectId}`)).body
      .filter((s: Json) => s.parentSessionId === parent)
      .sort((a: Json, b: Json) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const call = async (parent: string, tasks: unknown[]): Promise<Json> => {
    const before = (await log()).filter((l) => l.op === "subagent" && l.sessionId === parent).length;
    await send(parent, `sub ${JSON.stringify(tasks)}`);
    return waitFor(async () => {
      const calls = (await log()).filter((l) => l.op === "subagent" && l.sessionId === parent);
      return calls.length > before && calls.at(-1)?.result;
    });
  };

  test("an unarmed run still completes", async () => {
    const id = await newSession();
    expect((await send(id, "hi")).status).toBe(201);
    const [a] = await done(id, 1);
    expect(a?.message.status).toBe("complete");
    expect(textOf(a)).toBe("Hello, hi");
  });

  test("a denied message.complete still ends the run and the assistant message", async () => {
    const id = await newSession();
    expect((await arm(id, "deny")).status).toBe(200);
    await send(id, "hi");
    const [a] = await done(id, 1);
    expect(textOf(a)).toBe("Hello, hi");
    expect(a?.message.status).toBe("error");
    const run = await waitFor(async () => {
      const body = (await k.api(`/api/core/runs/${a?.message.runId}`)).body;
      return body.status !== "running" && body;
    });
    expect(run).toMatchObject({ status: "error" });
    expect(String(run.error)).toContain("complete refused");
    await waitFor(async () => (await sessionStatus(id)) === "idle");
  });

  test("a thrown message.complete still ends the run and the assistant message", async () => {
    const id = await newSession();
    expect((await arm(id, "throw")).status).toBe(200);
    await send(id, "hi");
    const [a] = await done(id, 1);
    expect(a?.message.status).toBe("error");
    expect(textOf(a)).toBe("Hello, hi");
    const run = await waitFor(async () => {
      const body = (await k.api(`/api/core/runs/${a?.message.runId}`)).body;
      return body.status !== "running" && body;
    });
    expect(run.status).toBe("error");
    expect(String(run.error)).toContain("message.complete");
    await waitFor(async () => (await sessionStatus(id)) === "idle");
  });

  test("aborting the parent cancels only that task's active run", async () => {
    const parent = await newSession();
    await send(parent, `sub ${JSON.stringify([{ prompt: "slow task", title: "Kid" }])}`);
    const childId = await waitFor(async () => (await childrenOf(parent))[0]?.id);
    const taskRun = await waitFor(async () => (await state(childId)).activeRunId);
    await send(childId, "user ping");
    await waitFor(async () => (await state(childId)).queued === 1);
    const parentRun = await waitFor(async () => (await state(parent)).activeRunId);
    expect((await k.api(`/api/core/runs/${parentRun}/cancel`, { method: "POST", body: {} })).status).toBe(
      200,
    );

    const list = await done(childId, 2);
    expect(list[0]?.message.runId).toBe(taskRun);
    expect(list[0]?.message.status).toBe("interrupted");
    expect((await k.api(`/api/core/runs/${taskRun}`)).body.status).toBe("cancelled");
    expect(list[1]?.message.status).toBe("complete");
    expect(textOf(list[1])).toBe("Hello, user ping");
    expect((await state(childId)).queued).toBe(0);
  });

  test("aborting the parent drops only that task's pending job", async () => {
    const parent = await newSession();
    const first = await call(parent, [{ prompt: "hello", title: "Kid" }]);
    const childId = first.meta.sessions[0].sessionId as string;

    await send(childId, "slow user");
    const slowRun = await waitFor(async () => (await state(childId)).activeRunId);
    await send(parent, `sub ${JSON.stringify([{ prompt: "should-not-run", session: childId }])}`);
    await waitFor(async () => (await state(childId)).queued === 1);
    await send(childId, "user later");
    await waitFor(async () => (await state(childId)).queued === 2);
    const parentRun = await waitFor(async () => (await state(parent)).activeRunId);
    expect((await k.api(`/api/core/runs/${parentRun}/cancel`, { method: "POST", body: {} })).status).toBe(
      200,
    );

    await waitFor(async () => {
      const s = await state(childId);
      return s.activeRunId === slowRun && s.queued === 1;
    });
    expect((await k.api(`/api/core/runs/${slowRun}/cancel`, { method: "POST", body: {} })).status).toBe(200);
    await waitFor(async () => (await sessionStatus(childId)) === "idle");

    const replies = (await assistants(childId)).map((e) => textOf(e));
    expect(replies).toEqual(["Hello, hello", "working", "Hello, user later"]);
    expect((await messages(childId)).some((e) => textOf(e) === "should-not-run")).toBe(true);
  });

  test("a tool-only assistant turn is replayed into the next harness prompt", async () => {
    const token = crypto.randomUUID();
    const id = await newSession();
    const created = await k.api(`/api/core/sessions/${id}/messages`, {
      method: "POST",
      body: {
        role: "assistant",
        status: "complete",
        parts: [
          {
            type: "tool-call",
            callId: "c1",
            name: "echo",
            input: { cmd: "ls" },
            output: token,
            status: "done",
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    await send(id, "next");
    await done(id, 2);
    const prompt = (await log()).find((l) => l.op === "prompt" && String(l.text).includes(token));
    expect(String(prompt?.text)).toContain(
      `Assistant: [tool echo ${JSON.stringify({ cmd: "ls" })}: ${token}]`,
    );
  });
});
