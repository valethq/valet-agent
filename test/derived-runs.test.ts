import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "../src/env";
import { RunQueue } from "../src/queue";
import { type Json, type Kernel, startKernel, waitFor } from "./kernel";

let k: Kernel;
let projectId: string;

beforeAll(async () => {
  k = await startKernel();
  projectId = (
    await k.api("/api/core/projects", {
      method: "POST",
      body: { name: "p", workspaceDir: mkdtempSync(join(tmpdir(), "valet-agent-derived-")) },
    })
  ).body.id;
});
afterAll(() => k.stop());

const newSession = async (): Promise<string> =>
  (
    await k.api("/api/core/sessions", {
      method: "POST",
      body: { projectId, settings: { model: { provider: "fake-agent", model: "m1" } } },
    })
  ).body.id;
const post = (sessionId: string, role: string, parts: Json[]) =>
  k.api(`/api/core/sessions/${sessionId}/messages`, { method: "POST", body: { role, parts } });
const messages = async (sessionId: string): Promise<Json[]> =>
  (await k.api(`/api/core/sessions/${sessionId}/messages`)).body;

describe("runs and their subjects (kernel)", () => {
  test("a user message starts a run stored with the author as its subject", async () => {
    const id = await newSession();
    await post(id, "user", [{ type: "text", text: "hello" }]);
    const reply = await waitFor(async () =>
      (await messages(id)).find((m) => m.message.role === "assistant" && m.message.status === "complete"),
    );
    const run = (await k.api(`/api/core/runs/${reply.message.runId}`)).body;
    const user = (await messages(id))[0]?.message;
    expect(run.subject).toEqual({ principalId: user.authorPrincipalId });
    expect(run.status).toBe("complete");
  });

  test("a refused message ends the wait of whoever posted it, and runs nothing", () => {
    const queue = new RunQueue({} as Env);
    const finished: unknown[] = [];
    queue.onFinished((f) => finished.push(f));
    queue.refuse("ses", "msg");
    expect(finished).toEqual([{ sessionId: "ses", messageId: "msg" }]);
    expect(queue.snapshot("ses")).toEqual({ queued: 0 });
  });
});
