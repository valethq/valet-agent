import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role, ToolCall, ToolResult } from "@valethq/sdk";
import type { AgentCtx } from "../src/env";
import { presentedOf, presentTool } from "../src/present";
import { aclParts, callerOf, principals } from "./acl";
import { type Json, type Kernel, startKernel, waitFor } from "./kernel";

const tmp = () => mkdtempSync(join(tmpdir(), "valet-present-"));

function harness(config: Record<string, unknown> = {}) {
  const blobs: { bytes: string; meta: { mime?: string; name?: string } }[] = [];
  const ctx = {
    ...aclParts,
    config,
    store: {
      principals,
      sessions: { get: () => undefined },
      blobs: {
        put: async (b: Blob, meta: { mime?: string; name?: string }) => {
          blobs.push({ bytes: await b.text(), meta });
          return { id: `blb_${blobs.length}` };
        },
      },
    },
  } as unknown as AgentCtx;
  const tool = presentTool(ctx);
  const run = (cwd: string, input: { path?: unknown; name?: unknown }, role: Role = "owner") =>
    tool.invoke(input, {
      cwd,
      role,
      sessionId: "ses_1",
      caller: callerOf(role),
    } as ToolCall) as Promise<ToolResult>;
  return { blobs, run, tool };
}

describe("present tool", () => {
  test("a file becomes one blob, named after its basename or the given name", async () => {
    const ws = tmp();
    writeFileSync(join(ws, "chart.png"), "png-bytes");
    const h = harness();
    const res = await h.run(ws, { path: "chart.png" });
    expect(presentedOf(res)).toEqual([{ blobId: "blb_1", name: "chart.png", mime: "image/png" }]);
    expect(h.blobs[0]).toEqual({ bytes: "png-bytes", meta: { mime: "image/png", name: "chart.png" } });
    const renamed = await h.run(ws, { path: join(ws, "chart.png"), name: "Q3.png" });
    expect(presentedOf(renamed)[0]?.name).toBe("Q3.png");
  });

  test("a folder becomes its files with relative names; hidden files and symlinks are skipped", async () => {
    const ws = tmp();
    mkdirSync(join(ws, "out/sub"), { recursive: true });
    writeFileSync(join(ws, "out/a.txt"), "a");
    writeFileSync(join(ws, "out/sub/b.txt"), "b");
    writeFileSync(join(ws, "out/.env"), "secret");
    symlinkSync(join(ws, "out/a.txt"), join(ws, "out/link.txt"));
    const res = await harness().run(ws, { path: "out" });
    expect(presentedOf(res).map((p) => p.name)).toEqual(["out/a.txt", "out/sub/b.txt"]);
  });

  test("paths outside the workspace are refused, including through a symlink", async () => {
    const ws = tmp();
    const other = tmp();
    writeFileSync(join(other, "secret.txt"), "s");
    symlinkSync(other, join(ws, "escape"));
    const h = harness();
    for (const path of [join(other, "secret.txt"), "../x", "escape/secret.txt"]) {
      const res = await h.run(ws, { path });
      expect(res.isError).toBe(true);
    }
    expect(h.blobs).toEqual([]);
  });

  test("presentRoots opens extra directories", async () => {
    const ws = tmp();
    const other = tmp();
    writeFileSync(join(other, "r.txt"), "r");
    expect(
      presentedOf(await harness({ presentRoots: [other] }).run(ws, { path: join(other, "r.txt") })),
    ).toHaveLength(1);
  });

  test("confinement is a setting, on by default, and off is owner-only", async () => {
    const ws = tmp();
    const other = tmp();
    writeFileSync(join(other, "s.txt"), "s");
    const outside = { path: join(other, "s.txt") };

    const open = harness({ presentConfine: false });
    expect(open.tool.minRole).toBe("owner");
    expect(presentedOf(await open.run(ws, outside))).toHaveLength(1);
    expect((await open.run(ws, outside, "trusted")).isError).toBe(true);

    const closed = harness({ presentConfine: true });
    expect(closed.tool.minRole).toBe("trusted");
    expect((await closed.run(ws, outside)).isError).toBe(true);
    expect(harness().tool.minRole).toBe("trusted");
  });

  test("blank presentRoots entries are ignored", async () => {
    const ws = tmp();
    const b = tmp();
    writeFileSync(join(b, "b.txt"), "b");
    const h = harness({ presentRoots: ["", b] });
    expect(presentedOf(await h.run(ws, { path: join(b, "b.txt") }))).toHaveLength(1);
  });

  test("guests are refused, and bad input or too many files is an error that stores nothing", async () => {
    const ws = tmp();
    mkdirSync(join(ws, "many"));
    for (let i = 0; i < 101; i++) writeFileSync(join(ws, "many", `f${i}.txt`), "x");
    writeFileSync(join(ws, "a.txt"), "a");
    const h = harness();
    expect((await h.run(ws, { path: "a.txt" }, "guest")).isError).toBe(true);
    expect((await h.run(ws, {})).isError).toBe(true);
    expect((await h.run(ws, { path: "missing" })).isError).toBe(true);
    expect((await h.run(ws, { path: "many" })).isError).toBe(true);
    expect(h.blobs).toEqual([]);
  });

  test("presentedOf ignores errors and malformed meta", () => {
    const good = { blobId: "b", name: "n", mime: "m" };
    expect(presentedOf({ content: [], meta: { presented: [good, { blobId: 1 }, null] } })).toEqual([good]);
    expect(presentedOf({ content: [], isError: true, meta: { presented: [good] } })).toEqual([]);
    expect(presentedOf({ content: [] })).toEqual([]);
  });
});

describe("present through the kernel", () => {
  let k: Kernel;
  let projectId: string;
  const ws = tmp();

  beforeAll(async () => {
    k = await startKernel();
    projectId = (await k.api("/api/core/projects", { method: "POST", body: { name: "p", workspaceDir: ws } }))
      .body.id;
    mkdirSync(join(ws, "out"));
    writeFileSync(join(ws, "out/a.txt"), "hello a");
    writeFileSync(join(ws, "out/b.txt"), "hello b");
  });
  afterAll(() => k.stop());

  async function turn(provider: string, text: string): Promise<Json[]> {
    const sessionId = (
      await k.api("/api/core/sessions", {
        method: "POST",
        body: { projectId, settings: { model: { provider, model: "m1" } } },
      })
    ).body.id as string;
    await k.api(`/api/core/sessions/${sessionId}/messages`, {
      method: "POST",
      body: { role: "user", parts: [{ type: "text", text }] },
    });
    return waitFor(async () => {
      const list = (await k.api(`/api/core/sessions/${sessionId}/messages`)).body as Json[];
      const a = list.filter((m) => m.message.role === "assistant");
      return a.length > 0 && a.every((m) => m.message.status === "complete") && a;
    });
  }

  const files = (assistants: Json[]) =>
    assistants.flatMap((m) => m.parts.filter((p: Json) => p.type === "file").map((p: Json) => p.data));

  async function expectBlobs(list: Json[]) {
    expect(list.map((f) => f.name)).toEqual(["out/a.txt", "out/b.txt"]);
    const bodies = await Promise.all(
      list.map((f) =>
        fetch(`${k.base}/api/core/blobs/${f.blobId}`, { headers: { authorization: "Bearer tok" } }).then(
          (r) => r.text(),
        ),
      ),
    );
    expect(bodies).toEqual(["hello a", "hello b"]);
  }

  test("a model-kind provider's present call lands as file parts after the tool call", async () => {
    const assistants = await turn("fake-model", "present out");
    await expectBlobs(files(assistants));
    const types = assistants.flatMap((m) => m.parts.map((p: Json) => p.type));
    expect(types.slice(0, 3)).toEqual(["tool-call", "file", "file"]);
    expect(assistants[0].parts.map((p: Json) => p.status)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
    ]);
    expect(assistants[0].parts[0].data.status).toBe("done");
  });

  test("an agent-kind provider's present call through the tool surface lands as file parts", async () => {
    const assistants = await turn("fake-agent", "present out");
    await expectBlobs(files(assistants));
  });

  test("a refused path leaves no file parts and an error on the tool call", async () => {
    const assistants = await turn("fake-model", "present ../nowhere");
    expect(files(assistants)).toEqual([]);
    expect(assistants[0].parts[0].data.status).toBe("error");
  });
});
