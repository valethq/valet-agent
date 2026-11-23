import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Json, type Kernel, startKernel, waitFor } from "./kernel";

interface Entry {
  message: { id: string; seq: number; role: string; status: string; runId: string | null; meta: Json };
  parts: { type: string; data: Json }[];
}

let k: Kernel;
let projectA: string;
let projectB: string;
const agent = { model: { provider: "fake-agent", model: "m1" } };

const newProject = async (name: string): Promise<string> =>
  (
    await k.api("/api/core/projects", {
      method: "POST",
      body: { name, workspaceDir: mkdtempSync(join(tmpdir(), "valet-agent-ws-")) },
    })
  ).body.id;

beforeAll(async () => {
  k = await startKernel();
  projectA = await newProject("alpha");
  projectB = await newProject("beta");
});
afterAll(() => k.stop());

const newSession = async (projectId = projectA, title?: string): Promise<string> =>
  (await k.api("/api/core/sessions", { method: "POST", body: { projectId, settings: agent, title } })).body
    .id;
const send = (sessionId: string, text: string) =>
  k.api(`/api/core/sessions/${sessionId}/messages`, {
    method: "POST",
    body: { role: "user", parts: [{ type: "text", text }] },
  });
const messages = async (sessionId: string): Promise<Entry[]> =>
  (await k.api(`/api/core/sessions/${sessionId}/messages`)).body;
const sessionOf = async (sessionId: string) => k.api(`/api/core/sessions/${sessionId}`);
const log = async (): Promise<Record<string, Json>[]> =>
  (await fetch(`${k.base}/plugins/valet-fixture-inference/log`)).json() as Promise<Record<string, Json>[]>;
const textOf = (e: Entry) =>
  e.parts
    .filter((p) => p.type === "text")
    .map((p) => p.data.text)
    .join("");
const replies = (sessionId: string, n: number) =>
  waitFor(async () => {
    const list = (await messages(sessionId)).filter((m) => m.message.role === "assistant");
    return list.length >= n && list.every((a) => a.message.status !== "streaming") && list;
  });
const runsIn = async (sessionId: string) =>
  (await messages(sessionId)).filter((m) => m.message.runId !== null).length;

/** A session with two finished turns: hi / Hello, hi / again / Hello, again. */
async function chat(projectId = projectA): Promise<{ id: string; entries: Entry[] }> {
  const id = await newSession(projectId, "Chat");
  await send(id, "hi");
  await replies(id, 1);
  await send(id, "again");
  await replies(id, 2);
  return { id, entries: await messages(id) };
}

describe("fork", () => {
  test("copies the chat through the chosen message without rerunning it", async () => {
    const { id, entries } = await chat();
    const at = entries[1] as Entry;
    const res = await k.api(`/plugins/valet-agent/sessions/${id}/fork`, {
      method: "POST",
      body: { messageId: at.message.id },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ projectId: projectA, title: "Chat (fork)" });
    expect(res.body.settings.agent.forkedFrom).toEqual({ sessionId: id, messageId: at.message.id });

    const copied = await messages(res.body.id);
    expect(copied.map((e) => [e.message.seq, e.message.role, textOf(e)])).toEqual([
      [1, "user", "hi"],
      [2, "assistant", "Hello, hi"],
    ]);
    expect(copied.every((e) => e.message.runId === null && e.message.meta.agent.copiedFrom)).toBe(true);
    await Bun.sleep(100);
    expect(await runsIn(res.body.id)).toBe(0);
    expect(await messages(id)).toHaveLength(4);
  });

  test("a fresh harness session in the fork gets the copied history", async () => {
    const { id } = await chat();
    const fork = (await k.api(`/plugins/valet-agent/sessions/${id}/fork`, { method: "POST" })).body;
    await send(fork.id, "next");
    const reply = (await replies(fork.id, 3))[2] as Entry;
    expect(textOf(reply).endsWith("(end of transcript)]next")).toBe(true);
    const prompt = (await log()).filter((l) => l.op === "prompt").at(-1) as Json;
    expect(prompt.text).toContain(
      "User: hi\n\nAssistant: Hello, hi\n\nUser: again\n\nAssistant: Hello, again",
    );
    expect(prompt.text.endsWith("(end of transcript)]next")).toBe(true);
    expect(prompt.preamble).toBe("PREAMBLE");
  });

  test("/fork forks at the latest message; unknown ids are 404", async () => {
    const { id } = await chat();
    expect((await send(id, "/fork")).body.error.code).toBe("cancelled");
    const reply = await waitFor(async () =>
      (await messages(id)).find((e) => textOf(e).startsWith("Forked: ")),
    );
    const forkId = textOf(reply).slice("Forked: ".length);
    expect((await messages(forkId)).map(textOf)).toEqual(["hi", "Hello, hi", "again", "Hello, again"]);
    const bad = await k.api(`/plugins/valet-agent/sessions/${id}/fork`, {
      method: "POST",
      body: { messageId: "msg_nope" },
    });
    expect(bad.status).toBe(404);
  });
});

describe("move", () => {
  test("copies the session into the other project and deletes the original", async () => {
    const { id } = await chat();
    const res = await k.api(`/plugins/valet-agent/sessions/${id}/move`, {
      method: "POST",
      body: { projectId: projectB },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: projectB, title: "Chat" });
    expect(res.body.settings.agent.movedFrom).toEqual({ sessionId: id, projectId: projectA });
    expect((await messages(res.body.id)).map(textOf)).toEqual(["hi", "Hello, hi", "again", "Hello, again"]);
    expect((await sessionOf(id)).status).toBe(404);
  });

  test("refuses while a turn is running, and into the same project", async () => {
    const id = await newSession();
    await send(id, "slow");
    await waitFor(async () => (await sessionOf(id)).body.status === "running");
    const busy = await k.api(`/plugins/valet-agent/sessions/${id}/move`, {
      method: "POST",
      body: { projectId: projectB },
    });
    expect(busy.status).toBe(400);
    expect(busy.body.error.message).toContain("a turn is running");
    await send(id, "/stop");
    await waitFor(async () => (await sessionOf(id)).body.status === "idle");
    const same = await k.api(`/plugins/valet-agent/sessions/${id}/move`, {
      method: "POST",
      body: { projectId: projectA },
    });
    expect(same.status).toBe(400);
    expect((await sessionOf(id)).status).toBe(200);
  });

  test("/move takes a project name and replies in the moved session", async () => {
    const { id } = await chat();
    await send(id, "/move beta");
    await waitFor(async () => (await sessionOf(id)).status === 404);
    const moved = (await k.api(`/api/core/sessions?projectId=${projectB}`)).body.find(
      (s: Json) => s.settings.agent?.movedFrom?.sessionId === id,
    );
    const entries = await messages(moved.id);
    expect(entries.map(textOf)).toEqual([
      "hi",
      "Hello, hi",
      "again",
      "Hello, again",
      "Moved here from alpha.",
    ]);
  });

  test("a doubled slash or encoded id authorizes the session the router serves", async () => {
    const { id } = await chat();
    const other = await newSession();
    const deny = await k.api("/plugins/valet-fixture-policy/deny", {
      method: "POST",
      body: { permission: "core:session.read", resource: `session:${id}` },
    });
    expect(deny.status).toBe(200);
    for (const path of [
      `/plugins/valet-agent/sessions/${id}/state`,
      `/plugins/valet-agent//sessions//${id}//state`,
      `/plugins/valet-agent/sessions/${id.slice(0, -1)}%${id
        .charCodeAt(id.length - 1)
        .toString(16)
        .padStart(2, "0")}/state`,
    ]) {
      const res = await k.api(path);
      expect(res.status).toBe(403);
    }
    expect((await k.api(`/plugins/valet-agent//sessions//${other}/state`)).status).toBe(200);
  });
});

describe("subagent", () => {
  const call = async (parent: string, tasks: unknown[]): Promise<Json> => {
    const before = (await log()).filter((l) => l.op === "subagent" && l.sessionId === parent).length;
    await send(parent, `sub ${JSON.stringify(tasks)}`);
    return waitFor(async () => {
      const calls = (await log()).filter((l) => l.op === "subagent" && l.sessionId === parent);
      return calls.length > before && calls.at(-1)?.result;
    });
  };
  const childrenOf = async (parent: string): Promise<Json[]> =>
    (await k.api(`/api/core/sessions?projectId=${projectA}`)).body
      .filter((s: Json) => s.parentSessionId === parent)
      .sort((a: Json, b: Json) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  test("runs a child session with the parent's role and returns its reply", async () => {
    const parent = await newSession();
    const result = await call(parent, [{ prompt: "look around", title: "Look" }]);
    expect(result.isError).toBeUndefined();
    const childId = result.meta.sessions[0].sessionId;
    expect(result.content[0].text).toStartWith("Hello, look around\n\n[subagent session ");

    const child = (await sessionOf(childId)).body;
    expect(child).toMatchObject({ parentSessionId: parent, projectId: projectA, title: "Look" });
    expect(child.settings.model).toEqual(agent.model);
    const [reply] = await replies(parent, 1);
    expect(child.settings.agent).toEqual({ parentRunId: reply?.message.runId, stage: 1 });
    const [prompt, answer] = await messages(childId);
    expect(prompt?.message.meta.agent.parentRunId).toBe(reply?.message.runId);
    const run = (await k.api(`/api/core/runs/${answer?.message.runId}`)).body;
    expect(run).toMatchObject({ status: "complete", role: "owner" });
  });

  test("tasks without a stage run in parallel", async () => {
    const parent = await newSession();
    const started = Date.now();
    const result = await call(parent, [{ prompt: "pause a" }, { prompt: "pause b" }, { prompt: "pause c" }]);
    expect(Date.now() - started).toBeLessThan(800);
    expect(result.meta.sessions.map((s: Json) => s.status)).toEqual(["complete", "complete", "complete"]);
    const text: string = result.content[0].text;
    expect(text.indexOf("Hello, pause a")).toBeLessThan(text.indexOf("Hello, pause b"));
    expect(text.match(/\[subagent session /g)).toHaveLength(3);
    const events = (await log()).filter((l) => /^pause [abc]$/.test(l.text));
    const starts = events.filter((l) => l.op === "start").map((l) => l.at);
    const firstEnd = Math.min(...events.filter((l) => l.op === "end").map((l) => l.at));
    expect(Math.max(...starts)).toBeLessThan(firstEnd);
  });

  test("stages run in order; tasks sharing a stage run together", async () => {
    const parent = await newSession();
    const result = await call(parent, [
      { prompt: "pause late", stage: 2 },
      { prompt: "pause early one", stage: 1 },
      { prompt: "pause early two", stage: 1 },
    ]);
    expect(result.isError).toBeUndefined();
    const events = (await log()).filter((l) => /^pause (late|early)/.test(l.text));
    const at = (op: string, text: string) => events.find((l) => l.op === op && l.text === text)?.at as number;
    expect(at("start", "pause early two")).toBeLessThan(at("end", "pause early one"));
    expect(at("start", "pause late")).toBeGreaterThanOrEqual(at("end", "pause early one"));
    expect(at("start", "pause late")).toBeGreaterThanOrEqual(at("end", "pause early two"));

    const kids = await childrenOf(parent);
    expect(kids.map((c) => c.settings.agent.stage)).toEqual([1, 1, 2]);
    const text: string = result.content[0].text;
    expect(text.indexOf("### pause early one")).toBeLessThan(text.indexOf("### pause late"));
  });

  test("a stage's children exist only once the stage starts", async () => {
    const parent = await newSession();
    const done = call(parent, [
      { prompt: "pause first", stage: 1 },
      { prompt: "pause second", stage: 2 },
    ]);
    await waitFor(async () => (await childrenOf(parent)).length === 1);
    expect(await childrenOf(parent)).toHaveLength(1);
    await done;
    expect(await childrenOf(parent)).toHaveLength(2);
  });

  test("continues its own child, and refuses a session that isn't one", async () => {
    const parent = await newSession();
    const first = await call(parent, [{ prompt: "first" }]);
    const childId = first.meta.sessions[0].sessionId;

    await call(parent, [{ prompt: "second", session: childId }]);
    expect((await messages(childId)).map(textOf)).toEqual([
      "first",
      "Hello, first",
      "second",
      "Hello, second",
    ]);

    const stranger = await newSession();
    const refused = await call(parent, [{ prompt: "third", session: stranger }]);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0].text).toContain("is not a subagent of this chat");
    expect(await messages(stranger)).toHaveLength(0);
  });

  test("a bad tasks list is refused before anything starts", async () => {
    const parent = await newSession();
    const text = async (tasks: unknown[]) => (await call(parent, tasks)).content[0].text as string;
    expect(await text([])).toBe("tasks must be a non-empty array");
    expect(await text([{ stage: 1 }])).toBe("tasks[0].prompt is required");
    expect(await text([{ prompt: "a", stage: 0 }])).toContain("tasks[0].stage must be a whole number");
    expect(await text([{ prompt: "a", stage: 1.5 }])).toContain("tasks[0].stage must be a whole number");
    expect(await text(Array.from({ length: 9 }, () => ({ prompt: "a" })))).toBe("at most 8 tasks per call");
    expect(await childrenOf(parent)).toHaveLength(0);
  });
});
