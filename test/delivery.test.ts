import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Json, type Kernel, startKernel, waitFor } from "./kernel";

interface Entry {
  message: { role: string; status: string };
  parts: { type: string; data: Record<string, Json> }[];
}

let k: Kernel;
let projectId: string;

beforeAll(async () => {
  k = await startKernel(undefined, { agentConfig: { queueMode: "interrupt" } });
  const res = await k.api("/api/core/projects", {
    method: "POST",
    body: { name: "p", workspaceDir: mkdtempSync(join(tmpdir(), "valet-delivery-ws-")) },
  });
  projectId = res.body.id;
}, 20_000);
afterAll(() => k.stop());

const newSession = async (): Promise<string> =>
  (
    await k.api("/api/core/sessions", {
      method: "POST",
      body: { projectId, settings: { model: { provider: "fake-agent", model: "m1" } } },
    })
  ).body.id;
const send = (sessionId: string, text: string, delivery?: "queue" | "interrupt") =>
  k.api(`/api/core/sessions/${sessionId}/messages`, {
    method: "POST",
    body: { role: "user", parts: [{ type: "text", text }], ...(delivery ? { delivery } : {}) },
  });
const assistants = async (sessionId: string): Promise<Entry[]> =>
  ((await k.api(`/api/core/sessions/${sessionId}/messages`)).body as Entry[]).filter(
    (m) => m.message.role === "assistant",
  );
const state = async (sessionId: string) =>
  (await k.api(`/plugins/valet-agent/sessions/${sessionId}/state`)).body;
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

test("delivery queue keeps the running turn although queueMode is interrupt", async () => {
  const id = await newSession();
  await send(id, "slow first");
  await waitFor(async () => (await state(id)).activeRunId);
  await send(id, "second", "queue");
  expect((await state(id)).queued).toBe(1);
  expect((await assistants(id)).every((a) => a.message.status === "streaming")).toBe(true);

  await k.api(`/api/core/runs/${(await state(id)).activeRunId}/cancel`, { method: "POST", body: {} });
  const [a, b] = await done(id, 2);
  expect(a?.message.status).toBe("interrupted");
  expect(textOf(b as Entry)).toBe("Hello, second");
});

test("omitting delivery falls back to the interrupt queueMode", async () => {
  const id = await newSession();
  await send(id, "slow first");
  const first = await waitFor(async () => (await state(id)).activeRunId);
  await send(id, "second");
  const [a, b] = await done(id, 2);
  expect(a?.message.status).toBe("interrupted");
  expect(textOf(b as Entry)).toBe("Hello, second");
  expect((await k.api(`/api/core/runs/${first}`)).body.status).toBe("cancelled");
});
