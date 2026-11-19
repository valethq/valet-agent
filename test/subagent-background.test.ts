import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store, ToolCall } from "@valethq/sdk";
import type { Catalog } from "../src/catalog";
import type { AgentCtx } from "../src/env";
import type { RunQueue } from "../src/queue";
import { subagentTool } from "../src/subagent";
import { announce, SUBAGENT_END } from "../src/subagent-notify";
import { type Clock, wakeGroup, wakeGroupMs } from "../src/subagent-wake";
import type { Outcome } from "../src/subagent-text";
import { type Json, type Kernel, sleep, startKernel, waitFor } from "./kernel";

describe("subagent in the background (kernel)", () => {
  let k: Kernel;
  let projectId: string;
  const agent = { model: { provider: "fake-agent", model: "m1" } };

  beforeAll(async () => {
    k = await startKernel();
    projectId = (
      await k.api("/api/core/projects", {
        method: "POST",
        body: { name: "p", workspaceDir: mkdtempSync(join(tmpdir(), "valet-agent-ws-")) },
      })
    ).body.id;
  });
  afterAll(() => k?.stop());

  const newSession = async (): Promise<string> =>
    (await k.api("/api/core/sessions", { method: "POST", body: { projectId, settings: agent } })).body.id;
  const send = (sessionId: string, text: string) =>
    k.api(`/api/core/sessions/${sessionId}/messages`, {
      method: "POST",
      body: { role: "user", parts: [{ type: "text", text }] },
    });
  const messages = async (sessionId: string): Promise<Json[]> =>
    (await k.api(`/api/core/sessions/${sessionId}/messages`)).body;
  const log = async (): Promise<Record<string, Json>[]> =>
    (await fetch(`${k.base}/plugins/valet-fixture-inference/log`)).json() as Promise<Record<string, Json>[]>;
  const openGate = (name: string) =>
    fetch(`${k.base}/plugins/valet-fixture-inference/gate/${name}`, { method: "POST" });
  const childrenOf = async (parent: string): Promise<Json[]> =>
    (await k.api(`/api/core/sessions?projectId=${projectId}`)).body
      .filter((s: Json) => s.parentSessionId === parent)
      .sort((a: Json, b: Json) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const notifications = async (parent: string): Promise<Json[]> =>
    (await messages(parent)).filter((m) => m.message.role === "system");
  const assistants = async (parent: string): Promise<Json[]> =>
    (await messages(parent)).filter((m) => m.message.role === "assistant");
  const settled = (parent: string, n: number) =>
    waitFor(async () => {
      const list = await assistants(parent);
      return list.length >= n && list.every((a) => a.message.status !== "streaming") && list;
    });

  /** The subagent tool's result for one parent turn that calls it with `input` (an array of tasks, or the whole input). */
  const call = async (parent: string, input: unknown): Promise<Json> => {
    const before = (await log()).filter((l) => l.op === "subagent" && l.sessionId === parent).length;
    await send(parent, `sub ${JSON.stringify(input)}`);
    return waitFor(async () => {
      const calls = (await log()).filter((l) => l.op === "subagent" && l.sessionId === parent);
      return calls.length > before && calls.at(-1)?.result;
    });
  };
  const noteOf = (entry: Json): Json => entry.parts.find((p: Json) => p.type === "custom").data;

  test("subagents still running after yieldMs carry on and wake the chat once when the last one ends", async () => {
    const parent = await newSession();
    const result = await call(parent, {
      tasks: [
        { prompt: "gate bg1a", title: "One" },
        { prompt: "gate bg1b", title: "Two" },
      ],
      yieldMs: 100,
    });
    expect(result.isError).toBeUndefined();
    expect(result.meta.background).toBe(true);
    expect(result.meta.sessions.map((s: Json) => s.status)).toEqual(["running", "running"]);
    const kids = await childrenOf(parent);
    expect(kids).toHaveLength(2);
    expect(result.content[0].text).toContain("continue in the background");
    expect(result.content[0].text).toContain(`- One: running [session ${kids[0]?.id}]`);
    expect(result.content[0].text).toContain(`- Two: running [session ${kids[1]?.id}]`);
    await settled(parent, 1);

    await openGate("bg1a");
    await sleep(300);
    expect(await notifications(parent)).toHaveLength(0);

    await openGate("bg1b");
    const [entry] = await waitFor(async () => {
      const list = await notifications(parent);
      return list.length > 0 && list;
    });
    const part = entry?.parts[0];
    expect(part.data.kind).toBe(SUBAGENT_END.id);
    expect(part.data.title).toBe("Subagents finished: One, Two");
    expect(part.data.text).toContain("[valet-agent] 2 background subagents ended");
    expect(part.data.text).toContain("(all complete)");
    expect(part.data.text).toContain("### One\nHello, gate bg1a");
    expect(part.data.text).toContain("### Two\nHello, gate bg1b");
    expect(part.data.data.subagents).toEqual([
      { sessionId: kids[0]?.id, title: "One", status: "complete" },
      { sessionId: kids[1]?.id, title: "Two", status: "complete" },
    ]);

    const [, woken] = await settled(parent, 2);
    expect(woken?.message.status).toBe("complete");
    const run = (await k.api(`/api/core/runs/${woken?.message.runId}`)).body;
    expect(run).toMatchObject({ status: "complete", role: "owner", triggerMessageId: entry?.message.id });
    expect((await messages(parent)).map((m) => m.message.role)).toEqual([
      "user",
      "assistant",
      "system",
      "assistant",
    ]);
    expect(await notifications(parent)).toHaveLength(1);
  });

  test("subagents that end within the wait come back in the result, with no notification", async () => {
    const parent = await newSession();
    const result = await call(parent, { tasks: [{ prompt: "pause inline" }], yieldMs: 5000 });
    expect(result.isError).toBeUndefined();
    expect(result.meta.background).toBeUndefined();
    expect(result.content[0].text).toStartWith("Hello, pause inline\n\n[subagent session ");
    await settled(parent, 1);
    await sleep(400);
    expect(await notifications(parent)).toHaveLength(0);
    expect(await assistants(parent)).toHaveLength(1);
  });

  test("a later stage starts in the background once the earlier one ends", async () => {
    const parent = await newSession();
    const result = await call(parent, {
      tasks: [
        { prompt: "gate bg3", stage: 1, title: "First" },
        { prompt: "pause second", stage: 2, title: "Second" },
      ],
      yieldMs: 100,
    });
    expect(result.meta.background).toBe(true);
    expect(result.meta.sessions).toHaveLength(1);
    expect(result.content[0].text).toContain("- First: running");
    expect(result.content[0].text).toContain("- Second: not started yet (stage 2)");
    expect(await childrenOf(parent)).toHaveLength(1);

    await openGate("bg3");
    const [entry] = await waitFor(async () => {
      const list = await notifications(parent);
      return list.length > 0 && list;
    });
    const text: string = noteOf(entry).text;
    expect(text).toContain("2 background subagents ended");
    expect(text.indexOf("### First")).toBeLessThan(text.indexOf("### Second"));
    expect(text).toContain("Hello, pause second");
    expect(await childrenOf(parent)).toHaveLength(2);
  });

  test("stopping the call during the wait stops the subagents and posts no notification", async () => {
    const parent = await newSession();
    await send(
      parent,
      `sub ${JSON.stringify({ tasks: [{ prompt: "slow wait", title: "Slow" }], yieldMs: 60000 })}`,
    );
    const runId = await waitFor(async () => {
      const state = (await k.api(`/plugins/valet-agent/sessions/${parent}/state`)).body;
      return (await childrenOf(parent)).length === 1 && state.activeRunId;
    });
    const [child] = await childrenOf(parent);
    const childRun = await waitFor(async () => {
      const a = (await messages(child?.id)).find((m) => m.message.role === "assistant");
      return a?.message.runId as string | undefined;
    });
    expect((await k.api(`/api/core/runs/${childRun}`)).body.status).toBe("running");

    expect((await k.api(`/api/core/runs/${runId}/cancel`, { method: "POST", body: {} })).status).toBe(200);
    await waitFor(async () => (await k.api(`/api/core/runs/${childRun}`)).body.status === "cancelled");
    await waitFor(async () => (await k.api(`/api/core/runs/${runId}`)).body.status === "cancelled");
    await sleep(300);
    expect(await notifications(parent)).toHaveLength(0);
  });

  test("with grouping off every subagent wakes the chat on its own", async () => {
    const setGroup = (seconds: number) =>
      k.api("/api/core/settings/valet-agent", {
        method: "PATCH",
        body: { config: { subagentWakeGroupSeconds: seconds } },
      });
    expect((await setGroup(0)).status).toBe(200);
    try {
      const parent = await newSession();
      const result = await call(parent, {
        tasks: [
          { prompt: "gate bg5a", title: "One" },
          { prompt: "gate bg5b", title: "Two" },
        ],
        yieldMs: 100,
      });
      expect(result.meta.background).toBe(true);
      await settled(parent, 1);

      await openGate("bg5a");
      const first = await waitFor(async () => {
        const list = await notifications(parent);
        return list.length === 1 && list[0];
      });
      expect(noteOf(first).text).toContain("1 background subagent ended");
      expect(noteOf(first).text).toContain("Hello, gate bg5a");
      expect(noteOf(first).text).toContain("1 still running");
      expect(noteOf(first).text).not.toContain("Hello, gate bg5b");
      await settled(parent, 2);

      await openGate("bg5b");
      const second = await waitFor(async () => {
        const list = await notifications(parent);
        return list.length === 2 && list[1];
      });
      expect(noteOf(second).text).toContain("Hello, gate bg5b");
      expect(noteOf(second).text).toContain("none are left running");
      await settled(parent, 3);
    } finally {
      await setGroup(15);
    }
  });
});

describe("subagent wake grouping (timer)", () => {
  function fakeClock() {
    let now = 0;
    let next = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: Clock = {
      now: () => now,
      setTimeout(fn, ms) {
        next += 1;
        timers.set(next, { at: now + ms, fn });
        return next;
      },
      clearTimeout: (h) => void timers.delete(h as number),
    };
    const advance = (ms: number) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
        const first = due[0];
        if (!first) break;
        now = first[1].at;
        timers.delete(first[0]);
        first[1].fn();
      }
      now = target;
    };
    return { clock, advance, timers };
  }
  const out = (name: string): Outcome => ({
    task: { index: 0, prompt: name, stage: 1, title: name },
    status: "complete",
    reply: name,
    presented: [],
  });
  const names = (list: Outcome[]) => list.map((o) => o.task.title);

  function group(window: number, left: { n: number }) {
    const f = fakeClock();
    const posts: { names: (string | undefined)[]; remaining: number }[] = [];
    const g = wakeGroup(
      {
        windowMs: () => window,
        remaining: () => left.n,
        post: (outcomes, remaining) => posts.push({ names: names(outcomes), remaining }),
      },
      f.clock,
    );
    return { ...f, g, posts };
  }

  test("the first to end starts the timer, and each later one adds a whole window", () => {
    const { g, advance, posts, timers } = group(10_000, { n: 3 });
    g.add(out("a"));
    advance(6_000);
    g.add(out("b")); // 6s in: the deadline moves from 10s to 20s, not to 16s
    advance(9_000);
    g.add(out("c")); // 15s in: 20s becomes 30s
    advance(14_999);
    expect(posts).toEqual([]);
    advance(1);
    expect(posts).toEqual([{ names: ["a", "b", "c"], remaining: 3 }]);
    expect(timers.size).toBe(0);
  });

  test("one that ends after a group was posted starts a new group", () => {
    const { g, advance, posts } = group(10_000, { n: 2 });
    g.add(out("a"));
    advance(10_000);
    expect(posts.map((p) => p.names)).toEqual([["a"]]);
    advance(25_000);
    g.add(out("b"));
    advance(9_999);
    expect(posts).toHaveLength(1);
    advance(1);
    expect(posts.map((p) => p.names)).toEqual([["a"], ["b"]]);
  });

  test("when none are left running the group posts at once, with whatever is waiting", () => {
    const left = { n: 3 };
    const { g, advance, posts, timers } = group(60_000, left);
    g.add(out("a"));
    left.n = 1;
    g.add(out("b"));
    advance(5_000);
    expect(posts).toEqual([]);
    left.n = 0;
    g.add(out("c"));
    expect(posts).toEqual([{ names: ["a", "b", "c"], remaining: 0 }]);
    expect(timers.size).toBe(0);
  });

  test("a window of 0 posts every one on its own, and flush with nothing waiting does nothing", () => {
    const { g, posts } = group(0, { n: 5 });
    g.add(out("a"));
    g.add(out("b"));
    g.flush();
    expect(posts).toEqual([
      { names: ["a"], remaining: 5 },
      { names: ["b"], remaining: 5 },
    ]);
  });

  test("flush posts what is waiting before the timer does", () => {
    const { g, advance, posts } = group(10_000, { n: 1 });
    g.add(out("a"));
    g.flush();
    advance(20_000);
    expect(posts).toEqual([{ names: ["a"], remaining: 1 }]);
  });

  test("the setting is seconds, 0 or more, 15 when unset or invalid", () => {
    expect(wakeGroupMs({})).toBe(15_000);
    expect(wakeGroupMs({ subagentWakeGroupSeconds: 0 })).toBe(0);
    expect(wakeGroupMs({ subagentWakeGroupSeconds: 2.5 })).toBe(2_500);
    expect(wakeGroupMs({ subagentWakeGroupSeconds: -3 })).toBe(15_000);
    expect(wakeGroupMs({ subagentWakeGroupSeconds: Number.NaN })).toBe(15_000);
    expect(wakeGroupMs({ subagentWakeGroupSeconds: "5" as unknown as number })).toBe(15_000);
  });
});

describe("subagent yield window (unit)", () => {
  interface Finished {
    sessionId: string;
    messageId: string;
    runId?: string;
  }

  function rig(opts: { principal?: boolean; children?: string[]; wakeGroupSeconds?: number } = {}) {
    const known = opts.principal ?? true;
    const ids = opts.children ?? ["child"];
    const call = new AbortController();
    const valet = new AbortController();
    const seen = { cancel: [] as string[], posted: [] as Json[], warned: [] as string[] };
    const listeners = new Set<(f: Finished) => void>();
    const queue = {
      onFinished(fn: (f: Finished) => void) {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
      async cancelActive(sessionId: string) {
        seen.cancel.push(sessionId);
        return true;
      },
      dropJob: () => true,
      activeMessageId: (sessionId: string) => `m-${sessionId}`,
    } as unknown as RunQueue;
    const sessions = new Map<string, Json>([
      ["parent", { id: "parent", parentSessionId: null, projectId: "p", settings: {} }],
      ...ids.map((id): [string, Json] => [
        id,
        { id, parentSessionId: "parent", projectId: "p", settings: {} },
      ]),
    ]);
    const store: Json = {
      sessions: { get: (id: string) => sessions.get(id) },
      projects: { get: () => undefined },
      principals: { get: (id: string) => (known && id === "owner" ? { id, role: "owner" } : undefined) },
      as: () => store,
      messages: {
        create: async (m: Json) => {
          if (m.role === "system") {
            seen.posted.push(m);
            return { message: { id: "note" }, parts: [] };
          }
          return { message: { id: `m-${m.sessionId}` } };
        },
        list: (sessionId: string) => [
          {
            message: { role: "assistant", runId: `run-${sessionId}` },
            parts: [{ data: { type: "text", text: `done ${sessionId}` } }],
          },
        ],
      },
      runs: { get: (id: string) => (id.startsWith("run-") ? { status: "complete" } : undefined) },
    };
    const ctx = {
      plugin: { id: "valet-agent" },
      config: opts.wakeGroupSeconds === undefined ? {} : { subagentWakeGroupSeconds: opts.wakeGroupSeconds },
      signal: valet.signal,
      store: store as Store,
      scopes: { maybe: () => undefined },
      log: {
        warn: (m: string) => seen.warned.push(m),
        error: (m: string) => seen.warned.push(m),
      },
    } as unknown as AgentCtx;
    const invoke = (input: Json) =>
      subagentTool(ctx, queue, {} as Catalog).invoke(input, {
        role: "owner",
        sessionId: "parent",
        runId: "run-parent",
        signal: call.signal,
        caller: { plugin: "valet-agent", actor: { principalId: "owner", role: "owner" } },
      } as ToolCall);
    const end = (id = "child") => {
      for (const fn of [...listeners]) fn({ sessionId: id, messageId: `m-${id}`, runId: `run-${id}` });
    };
    return { call, valet, seen, ctx, invoke, end };
  }

  const tasksOf = (ids: string[]) => ids.map((id) => ({ prompt: `task ${id}`, session: id }));
  const tasks = tasksOf(["child"]);
  const text = (r: { content: { type: string; text?: string }[] }) =>
    r.content[0]?.type === "text" ? r.content[0].text : "";
  const noteText = (t: ReturnType<typeof rig>, n: number): string => t.seen.posted[n]?.parts[0].text;

  test("after yieldMs it returns the running subagents, then wakes the chat when they end", async () => {
    const t = rig();
    const result = await t.invoke({ tasks, yieldMs: 20 });
    expect(result.isError).toBeUndefined();
    expect(result.meta).toMatchObject({
      background: true,
      sessions: [{ sessionId: "child", status: "running" }],
    });
    expect(text(result)).toContain("do not poll or sleep");
    expect(t.seen.posted).toHaveLength(0);

    t.end();
    await waitFor(() => t.seen.posted.length === 1);
    const [note] = t.seen.posted;
    expect(note).toMatchObject({ sessionId: "parent", role: "system", authorPrincipalId: "owner" });
    expect(note.parts[0]).toMatchObject({ type: "custom", kind: "valet-agent/subagent-end@1" });
    expect(noteText(t, 0)).toContain("1 background subagent ended");
    expect(noteText(t, 0)).toContain("none are left running");
    expect(noteText(t, 0)).toContain("done child");
    await sleep(30);
    expect(t.seen.posted).toHaveLength(1);
  });

  test("a subagent that ends late wakes the chat alone after the grouping window, and the next starts a new group", async () => {
    const t = rig({ children: ["a", "b"], wakeGroupSeconds: 0.25 });
    const result = await t.invoke({ tasks: tasksOf(["a", "b"]), yieldMs: 10 });
    expect(result.meta?.background).toBe(true);

    const endedAt = Date.now();
    t.end("a");
    await sleep(100);
    expect(t.seen.posted).toHaveLength(0);
    await waitFor(() => t.seen.posted.length === 1);
    expect(Date.now() - endedAt).toBeGreaterThanOrEqual(200);
    expect(noteText(t, 0)).toContain("1 background subagent ended");
    expect(noteText(t, 0)).toContain("done a");
    expect(noteText(t, 0)).not.toContain("done b");
    expect(noteText(t, 0)).toContain("1 still running");

    t.end("b");
    await waitFor(() => t.seen.posted.length === 2);
    expect(noteText(t, 1)).toContain("done b");
    expect(noteText(t, 1)).not.toContain("done a");
  });

  test("when the last subagent ends the group is posted at once, whatever time is left on the timer", async () => {
    const t = rig({ children: ["a", "b", "c"], wakeGroupSeconds: 60 });
    await t.invoke({ tasks: tasksOf(["a", "b", "c"]), yieldMs: 10 });
    t.end("a");
    t.end("b");
    await sleep(50);
    expect(t.seen.posted).toHaveLength(0);

    t.end("c");
    await waitFor(() => t.seen.posted.length === 1);
    expect(noteText(t, 0)).toContain("3 background subagents ended");
    for (const id of ["a", "b", "c"]) expect(noteText(t, 0)).toContain(`done ${id}`);
    expect(noteText(t, 0)).toContain("none are left running");
    await sleep(30);
    expect(t.seen.posted).toHaveLength(1);
  });

  test("with grouping set to 0 every subagent wakes the chat on its own", async () => {
    const t = rig({ children: ["a", "b"], wakeGroupSeconds: 0 });
    await t.invoke({ tasks: tasksOf(["a", "b"]), yieldMs: 10 });
    t.end("a");
    await waitFor(() => t.seen.posted.length === 1);
    expect(noteText(t, 0)).toContain("done a");
    expect(noteText(t, 0)).toContain("1 still running");
    t.end("b");
    await waitFor(() => t.seen.posted.length === 2);
    expect(noteText(t, 1)).toContain("done b");
    expect(noteText(t, 1)).not.toContain("done a");
  });

  test("a subagent that ended before the hand-off is in the result and does not wake the chat", async () => {
    const t = rig({ children: ["a", "b"], wakeGroupSeconds: 0 });
    setTimeout(() => t.end("a"), 10);
    const result = await t.invoke({ tasks: tasksOf(["a", "b"]), yieldMs: 100 });
    expect(result.meta).toMatchObject({
      background: true,
      sessions: [
        { sessionId: "a", status: "complete" },
        { sessionId: "b", status: "running" },
      ],
    });
    expect(text(result)).toContain("1 of 2 subagents continue in the background");
    expect(text(result)).toContain("- task a: finished [session a]");
    expect(text(result)).toContain("- task b: running [session b]");
    expect(text(result)).toContain("Already ended:");
    expect(text(result)).toContain("done a");
    expect(text(result)).not.toContain("done b");
    await sleep(30);
    expect(t.seen.posted).toHaveLength(0);

    t.end("b");
    await waitFor(() => t.seen.posted.length === 1);
    expect(noteText(t, 0)).toContain("done b");
    expect(noteText(t, 0)).not.toContain("done a");
  });

  test("stopping the call after the hand-off leaves the subagents running; stopping valet cancels them silently", async () => {
    const t = rig({ children: ["a", "b"], wakeGroupSeconds: 0 });
    await t.invoke({ tasks: tasksOf(["a", "b"]), yieldMs: 10 });
    t.call.abort();
    await sleep(30);
    expect(t.seen.cancel).toEqual([]);

    t.valet.abort();
    await waitFor(() => t.seen.cancel.length === 2);
    expect(t.seen.cancel.sort()).toEqual(["a", "b"]);
    await sleep(30);
    expect(t.seen.posted).toHaveLength(0);
  });

  test("stopping valet while a group is waiting posts nothing", async () => {
    const t = rig({ children: ["a", "b"], wakeGroupSeconds: 0.05 });
    await t.invoke({ tasks: tasksOf(["a", "b"]), yieldMs: 10 });
    t.end("a");
    t.valet.abort();
    await sleep(150);
    expect(t.seen.posted).toHaveLength(0);
  });

  test("stopping the call during the wait cancels the subagents and posts nothing", async () => {
    const t = rig();
    setTimeout(() => t.call.abort(), 20);
    const result = await t.invoke({ tasks, yieldMs: 5000 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("cancelled");
    expect(t.seen.cancel).toEqual(["child"]);
    await sleep(30);
    expect(t.seen.posted).toHaveLength(0);
  });

  test("a call already stopped when it starts cancels at once", async () => {
    const t = rig();
    t.call.abort();
    const result = await t.invoke({ tasks, yieldMs: 5000 });
    expect(result.isError).toBe(true);
    expect(t.seen.posted).toHaveLength(0);
  });

  test("subagents that end within the wait return their replies and post nothing", async () => {
    const t = rig();
    setTimeout(() => t.end(), 10);
    const result = await t.invoke({ tasks, yieldMs: 5000 });
    expect(result.isError).toBeUndefined();
    expect(result.meta?.background).toBeUndefined();
    expect(text(result)).toStartWith("done child\n\n[subagent session child;");
    await sleep(30);
    expect(t.seen.posted).toHaveLength(0);
  });

  test("without a known author there is nobody to wake, so the call waits for the replies", async () => {
    const t = rig({ principal: false });
    setTimeout(() => t.end(), 60);
    const result = await t.invoke({ tasks, yieldMs: 0 });
    expect(result.meta?.background).toBeUndefined();
    expect(text(result)).toStartWith("done");
    expect(t.seen.posted).toHaveLength(0);
  });

  test("yieldMs must be a number of milliseconds, and is capped rather than refused", async () => {
    const t = rig();
    for (const bad of [-1, "soon", Number.NaN, null]) {
      const r = await t.invoke({ tasks, yieldMs: bad });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe("yieldMs must be a number of milliseconds, 0 or more");
    }
    setTimeout(() => t.end(), 10);
    const capped = await t.invoke({ tasks, yieldMs: 1e12 });
    expect(capped.isError).toBeUndefined();
    expect(text(capped)).toStartWith("done");
  });

  test("the notification cuts long replies, counts failures and names the subagents", async () => {
    const t = rig();
    const done = (title: string, reply: string, status = "complete", error?: string): Outcome => ({
      task: { index: 0, prompt: "p", stage: 1, title },
      session: { id: `ses_${title}` } as Outcome["session"],
      status,
      reply,
      presented: [],
      ...(error ? { error } : {}),
    });
    await announce(t.ctx, {
      sessionId: "parent",
      principalId: "owner",
      startedAt: Date.now() - 125_000,
      remaining: 2,
      outcomes: [done("Long", "x".repeat(9000)), done("Broken", "", "error", "boom")],
    });
    const [note] = t.seen.posted;
    const part = note.parts[0];
    expect(part.title).toBe("Subagents ended: Long, Broken");
    expect(part.text).toContain(
      "2 background subagents ended after 2m 5s (1 of 2 complete); 2 still running",
    );
    expect(part.text).toContain(`${"x".repeat(8000)}…`);
    expect(part.text).not.toContain("x".repeat(8001));
    expect(part.text).toContain(
      "reply cut at 8000 characters; session_view with the session id has the rest",
    );
    expect(part.text).toContain("The subagent run error: boom.");
    expect(part.data.subagents.map((s: Json) => s.status)).toEqual(["complete", "error"]);
  });

  test("a notification that cannot be posted is logged, and one for a deleted chat is dropped", async () => {
    const t = rig();
    const store = t.ctx.store as unknown as Json;
    const outcomes: Outcome[] = [
      { task: { index: 0, prompt: "p", stage: 1 }, status: "complete", reply: "ok", presented: [] },
    ];
    const base = { principalId: "owner", startedAt: Date.now(), remaining: 0, outcomes };

    store.messages.create = async () => ({ cancelled: true, cancelReason: "denied" });
    await announce(t.ctx, { ...base, sessionId: "parent" });
    store.messages.create = async () => {
      throw new Error("db closed");
    };
    await announce(t.ctx, { ...base, sessionId: "parent" });
    expect(t.seen.warned).toEqual(["subagent notification refused", "subagent notification failed"]);

    store.messages.create = async () => {
      throw new Error("must not be called");
    };
    await announce(t.ctx, { ...base, sessionId: "gone" });
    expect(t.seen.warned).toHaveLength(2);
  });
});
