import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Json, type Kernel, startKernel, waitFor } from "./kernel";

let k: Kernel;
let projectId: string;

beforeAll(async () => {
  k = await startKernel();
  const res = await k.api("/api/core/projects", {
    method: "POST",
    body: { name: "p", workspaceDir: mkdtempSync(join(tmpdir(), "valet-agent-tools-")) },
  });
  projectId = res.body.id;
});
afterAll(() => k.stop());

const log = async (): Promise<Record<string, Json>[]> =>
  (await fetch(`${k.base}/plugins/valet-fixture-inference/log`)).json() as Promise<Record<string, Json>[]>;

async function toolsTurn(): Promise<Record<string, Json>> {
  const sessionId = (
    await k.api("/api/core/sessions", {
      method: "POST",
      body: { projectId, settings: { model: { provider: "fake-agent", model: "m1" } } },
    })
  ).body.id as string;
  await k.api(`/api/core/sessions/${sessionId}/messages`, {
    method: "POST",
    body: { role: "user", parts: [{ type: "text", text: "mcp" }] },
  });
  await waitFor(async () => {
    const list = (await k.api(`/api/core/sessions/${sessionId}/messages`)).body as Json[];
    return list.some((m) => m.message.role === "assistant" && m.message.status === "complete");
  });
  const seen = (await log()).filter((l) => l.op === "tools").at(-1);
  if (!seen) throw new Error("fake agent logged no tool calls");
  return { sessionId, ...seen };
}

describe("tools for agent providers", () => {
  test("the provider gets the run's tools and calls them through the tool.call gate", async () => {
    const seen = await toolsTurn();
    expect(seen.listed).toEqual(["echo", "present"]);
    expect(seen.ok).toEqual({ content: [{ type: "text", text: 'echo:{"a":1}' }] });
    expect(seen.denied).toEqual({
      content: [{ type: "text", text: "Denied: fixture says no" }],
      isError: true,
    });
    expect(seen.rewritten).toEqual({ content: [{ type: "text", text: 'echo:{"rewritten":true}' }] });
    expect(seen.unknown).toEqual({ content: [{ type: "text", text: 'unknown tool "nope"' }], isError: true });
  });

  test("a call made after the run ends is refused, not run", async () => {
    await toolsTurn();
    const res = await fetch(`${k.base}/plugins/valet-fixture-inference/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "echo", input: { a: 1 } }),
    });
    expect(await res.json()).toEqual({
      content: [{ type: "text", text: "no valet run is active for this session" }],
      isError: true,
    });
  });

  test("the open log records how many tools the session was given", async () => {
    await toolsTurn();
    expect((await log()).filter((l) => l.op === "open").at(-1)?.tools).toBe(2);
  });
});
