import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Json, type Kernel, startKernel, waitFor } from "./kernel";

type Settings = Record<string, unknown>;
interface Entry {
  message: {
    id: string;
    role: string;
    status: string;
    runId: string | null;
    origin: { platform: string } | null;
    meta: Record<string, Json>;
  };
  parts: { type: string; status: string; data: Record<string, Json> }[];
}

let k: Kernel;
let projectId: string;

beforeAll(async () => {
  k = await startKernel();
  const res = await k.api("/api/core/projects", {
    method: "POST",
    body: { name: "p", workspaceDir: mkdtempSync(join(tmpdir(), "valet-agent-ws-")) },
  });
  projectId = res.body.id;
});
afterAll(() => k.stop());

const newSession = async (settings: Settings): Promise<string> =>
  (await k.api("/api/core/sessions", { method: "POST", body: { projectId, settings } })).body.id;
const send = (sessionId: string, text: string) =>
  k.api(`/api/core/sessions/${sessionId}/messages`, {
    method: "POST",
    body: { role: "user", parts: [{ type: "text", text }] },
  });
const messages = async (sessionId: string): Promise<Entry[]> =>
  (await k.api(`/api/core/sessions/${sessionId}/messages`)).body;
const assistants = async (sessionId: string) =>
  (await messages(sessionId)).filter((m) => m.message.role === "assistant");
const sessionOf = async (sessionId: string): Promise<{ status: string }> =>
  (await k.api(`/api/core/sessions/${sessionId}`)).body;
const state = async (sessionId: string) =>
  (await k.api(`/plugins/valet-agent/sessions/${sessionId}/state`)).body;
const log = async (): Promise<Record<string, Json>[]> =>
  (await fetch(`${k.base}/plugins/valet-fixture-inference/log`)).json() as Promise<Record<string, Json>[]>;
const contextLog = async (): Promise<Record<string, Json>[]> =>
  (await fetch(`${k.base}/plugins/valet-contextmanager/log`)).json() as Promise<Record<string, Json>[]>;
const textOf = (e: Entry) =>
  e.parts
    .filter((p) => p.type === "text")
    .map((p) => p.data.text)
    .join("");
const done = (sessionId: string, n: number) =>
  waitFor(async () => {
    const list = await assistants(sessionId);
    return list.length >= n && list.every((a) => a.message.status !== "streaming") && list;
  });
const agent = (model = "m1") => ({ model: { provider: "fake-agent", model } });

describe("agent kind", () => {
  test("message -> run -> streamed parts -> complete, with usage and preamble", async () => {
    const id = await newSession(agent());
    expect((await send(id, "hi")).status).toBe(201);
    const [a] = await done(id, 1);
    expect(a?.message.status).toBe("complete");
    expect(a?.parts.map((p) => p.type)).toEqual(["reasoning", "text"]);
    expect(a?.parts.every((p) => p.status === "complete")).toBe(true);
    expect(textOf(a as Entry)).toBe("Hello, hi");

    expect(a?.message.meta.model).toEqual({ provider: "fake-agent", model: "m1" });
    const run = (await k.api(`/api/core/runs/${a?.message.runId}`)).body;
    expect(run).toMatchObject({ status: "complete", provider: "fake-agent", model: "m1", role: "owner" });

    expect(await state(id)).toMatchObject({
      queued: 0,
      model: { provider: "fake-agent", model: "m1" },
      usage: { contextTokens: 100, contextWindow: 1000, inputTokens: 90, outputTokens: 10 },
    });
    expect((await state(id)).activeRunId).toBeUndefined();

    await send(id, "again");
    await done(id, 2);
    const prompts = (await log()).filter((l) => l.op === "prompt" && /^(hi|again)$/.test(l.text));
    expect(prompts.map((p) => p.preamble)).toEqual(["PREAMBLE", null]);

    expect(await contextLog()).toContainEqual({
      sessionId: id,
      role: "owner",
      model: { id: "m1", contextWindow: 1000 },
    });
  });

  test("tool events become one tool-call part updated in place", async () => {
    const id = await newSession(agent());
    await send(id, "tools please");
    const [a] = await done(id, 1);
    expect(a?.parts.map((p) => p.type)).toEqual(["tool-call", "reasoning", "text"]);
    expect(a?.parts[0]?.data).toMatchObject({
      callId: "c1",
      name: "shell",
      title: "Run ls",
      status: "done",
      output: "out",
    });
  });

  test("tool-end exitCode is stored in the tool part's result.meta", async () => {
    const id = await newSession(agent());
    await send(id, "exit now");
    const [a] = await done(id, 1);
    expect(a?.parts.map((p) => p.type)).toEqual(["tool-call", "reasoning", "text"]);
    expect(a?.parts[0]?.data).toMatchObject({
      callId: "c1",
      name: "shell",
      status: "error",
      output: "nope",
      result: { content: [], isError: true, meta: { exitCode: 3 } },
    });
  });

  test("a notice event becomes a standalone notice part, ordered between text parts", async () => {
    const id = await newSession(agent());
    await send(id, "note me");
    const [a] = await done(id, 1);
    expect(a?.parts.map((p) => p.type)).toEqual(["reasoning", "text", "notice", "text"]);
    expect(a?.parts[2]?.data).toMatchObject({ level: "warn", text: "heads up" });
    expect(textOf(a as Entry)).toBe("Hello, note me");
  });

  test("a second message queues, then runs after the first is cancelled", async () => {
    const id = await newSession(agent());
    await send(id, "slow first");
    const first = await waitFor(async () => (await state(id)).activeRunId);
    await send(id, "second");
    expect((await state(id)).queued).toBe(1);

    expect((await k.api(`/api/core/runs/${first}/cancel`, { method: "POST", body: {} })).status).toBe(200);
    const [a, b] = await done(id, 2);
    expect(a?.message.status).toBe("interrupted");
    expect(b?.message.status).toBe("complete");
    expect(textOf(b as Entry)).toBe("Hello, second");
    expect((await k.api(`/api/core/runs/${first}`)).body.status).toBe("cancelled");
  });

  test("/stop cancels the active run and replies", async () => {
    const id = await newSession(agent());
    await send(id, "slow one");
    const runId = await waitFor(async () => (await state(id)).activeRunId);
    const res = await send(id, "/stop");
    expect(res.status).toBe(409);
    const list = await waitFor(async () => {
      const l = await assistants(id);
      return l.length === 2 && l.every((x) => x.message.status !== "streaming") && l;
    });
    expect(list.map((x) => x.message.status)).toEqual(
      ["interrupted", "complete"]
        .sort(() => 0)
        .reverse()
        .reverse(),
    );
    expect(textOf(list[1] as Entry)).toBe("Stopped the active run.");
    expect(list[1]?.message.origin?.platform).toBe("system");
    expect((await k.api(`/api/core/runs/${runId}`)).body.status).toBe("cancelled");
    expect((await state(id)).activeRunId).toBeUndefined();
  });

  test("status is running while a run is active or queued, then idle", async () => {
    const id = await newSession(agent());
    await send(id, "slow first");
    const first = await waitFor(async () => (await state(id)).activeRunId);
    expect((await sessionOf(id)).status).toBe("running");
    await send(id, "second");
    await k.api(`/api/core/runs/${first}/cancel`, { method: "POST", body: {} });
    await done(id, 2);
    await waitFor(async () => (await sessionOf(id)).status === "idle");
  });

  test("deleting a session stops its run and drops its queue", async () => {
    const id = await newSession(agent());
    await send(id, "slow one");
    await waitFor(async () => (await state(id)).activeRunId);
    await send(id, "never runs");
    expect((await k.api(`/api/core/sessions/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await k.api(`/api/core/sessions/${id}`)).status).toBe(404);
    await Bun.sleep(300);
    expect((await log()).some((l) => l.op === "prompt" && l.text === "never runs")).toBe(false);
  });

  test("/model updates settings, cancels the message and setModel is called", async () => {
    const id = await newSession(agent());
    await send(id, "hi");
    await done(id, 1);
    const res = await send(id, "/model fake-agent:m2");
    expect(res.status).toBe(409);
    const [, reply] = await done(id, 2);
    expect(textOf(reply as Entry)).toBe("Model set to m2.");
    expect((await k.api(`/api/core/sessions/${id}`)).body.settings.model).toEqual({
      provider: "fake-agent",
      model: "m2",
    });
    expect((await messages(id)).filter((m) => m.message.role === "user")).toHaveLength(1);

    await send(id, "after");
    await done(id, 3);
    expect(await log()).toContainEqual({ op: "setModel", model: "m2" });
    expect((await state(id)).model).toMatchObject({ provider: "fake-agent", model: "m2" });
  });

  test("/new and /compact reply", async () => {
    const id = await newSession({ ...agent(), custom: 1 });
    await send(id, "/compact");
    await send(id, "/new");
    const list = await waitFor(async () => {
      const l = await assistants(id);
      return l.length === 2 && l;
    });
    const texts = list.map(textOf);
    expect(texts.find((t) => t.startsWith("Compaction failed: compaction not implemented"))).toBeDefined();
    const created = texts.find((t) => t.startsWith("New session: "))?.slice("New session: ".length) as string;
    const session = (await k.api(`/api/core/sessions/${created}`)).body;
    expect(session).toMatchObject({ projectId, settings: { ...agent(), custom: 1 } });
  });
});

describe("model kind and fallbacks", () => {
  test("tool loop with tools@1", async () => {
    const id = await newSession({ model: { provider: "fake-model", model: "m1" } });
    await send(id, "tool please");
    const [a] = await done(id, 1);
    expect(a?.message.status).toBe("complete");
    expect(a?.parts.map((p) => p.type)).toEqual(["tool-call", "text"]);
    expect(a?.parts[0]?.data).toMatchObject({
      callId: "t1",
      name: "echo",
      status: "done",
      output: 'echo:{"a":1}',
    });
    expect(textOf(a as Entry)).toBe('done: echo:{"a":1}');
    expect((await k.api(`/api/core/runs/${a?.message.runId}`)).body.status).toBe("complete");
  });

  test("falls back when the provider errors before output", async () => {
    const id = await newSession({
      model: { provider: "fake-bad", model: "x", fallbacks: [{ provider: "fake-agent", model: "m1" }] },
    });
    await send(id, "hi");
    const [a] = await done(id, 1);
    expect(a?.message.status).toBe("complete");
    expect(textOf(a as Entry)).toBe("Hello, hi");
    expect(a?.parts.find((p) => p.type === "notice")?.data).toMatchObject({
      level: "warn",
      text: "fake-bad:x failed: boom; used fake-agent:m1",
    });
    expect(a?.message.meta.model).toEqual({ provider: "fake-agent", model: "m1" });
    expect((await k.api(`/api/core/runs/${a?.message.runId}`)).body).toMatchObject({
      status: "complete",
      provider: "fake-agent",
    });
  });

  test("without fallbacks the run ends in error", async () => {
    const id = await newSession({ model: { provider: "fake-bad", model: "x" } });
    await send(id, "hi");
    const [a] = await done(id, 1);
    expect(a?.message.status).toBe("error");
    expect(a?.parts.map((p) => p.type)).toEqual(["notice"]);
    expect(a?.parts[0]?.data).toMatchObject({ level: "error", text: "boom" });
    expect(a?.message.meta.model).toEqual({ provider: "fake-bad", model: "x" });
    expect((await k.api(`/api/core/runs/${a?.message.runId}`)).body).toMatchObject({
      status: "error",
      error: "boom",
    });
  });
});

describe("titles", () => {
  test("the first user message titles the session; later messages do not change it", async () => {
    const id = await newSession(agent());
    await send(id, "please summarize this document");
    const title = await waitFor(async () => (await k.api(`/api/core/sessions/${id}`)).body.title);
    expect(title).toBe("please summarize this document");

    await send(id, "and now something completely different");
    await done(id, 2);
    expect((await k.api(`/api/core/sessions/${id}`)).body.title).toBe("please summarize this document");
  });
});

describe("http", () => {
  test("/models aggregates providers and is owner only", async () => {
    const { status, body } = await k.api("/plugins/valet-agent/models");
    expect(status).toBe(200);
    const kinds = Object.fromEntries(
      body.providers.map((p: { provider: string; kind: string }) => [p.provider, p.kind]),
    );
    expect(kinds).toEqual({ "fake-agent": "agent", "fake-model": "model", "fake-bad": "model" });
    expect(body.providers[0].models.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
    expect((await fetch(`${k.base}/plugins/valet-agent/models`)).status).toBe(401);
  });

  test("state of an unknown session is 404", async () => {
    expect((await k.api("/plugins/valet-agent/sessions/nope/state")).status).toBe(404);
  });
});

describe("restart", () => {
  test("a run left running by a killed process is interrupted on boot", async () => {
    const first = await startKernel();
    const home = first.home;
    const project = (
      await first.api("/api/core/projects", { method: "POST", body: { name: "p", workspaceDir: home } })
    ).body.id;
    const session = (
      await first.api("/api/core/sessions", {
        method: "POST",
        body: { projectId: project, settings: agent() },
      })
    ).body.id;
    await first.api(`/api/core/sessions/${session}/messages`, {
      method: "POST",
      body: { role: "user", parts: [{ type: "text", text: "slow" }] },
    });
    const runId = await waitFor(
      async () => (await first.api(`/plugins/valet-agent/sessions/${session}/state`)).body.activeRunId,
    );
    await waitFor(
      async () => (await first.api(`/api/core/sessions/${session}/messages`)).body[1]?.parts.length > 0,
    );
    expect((await first.api(`/api/core/sessions/${session}`)).body.status).toBe("running");
    await first.kill();

    const second = await startKernel(home);
    try {
      expect((await second.api(`/api/core/runs/${runId}`)).body.status).toBe("interrupted");
      const list: Entry[] = (await second.api(`/api/core/sessions/${session}/messages`)).body;
      const a = list.find((m) => m.message.role === "assistant");
      expect(a?.message.status).toBe("interrupted");
      expect(a?.parts.map((p) => p.status)).toEqual(["interrupted"]);
      await waitFor(async () => (await second.api(`/api/core/sessions/${session}`)).body.status === "idle");
    } finally {
      await second.stop();
    }
  });
});
