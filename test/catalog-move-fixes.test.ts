import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, ModelRef } from "@valethq/sdk";
import { Catalog, type CatalogRow, normalizeRef, runOptions } from "../src/catalog";
import type { AgentCtx } from "../src/env";
import { type Json, type Kernel, startKernel, waitFor } from "./kernel";

const info = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id,
  contextWindow: 1000,
  maxOutputTokens: 10,
  input: ["text"],
  reasoning: true,
  ...extra,
});

const ref = (model: string, extra: Partial<ModelRef> = {}): ModelRef => ({ provider: "p", model, ...extra });

function catalog(rows: CatalogRow[], listed: ModelInfo[]): Catalog {
  const ctx = {
    config: { models: rows },
    scopes: { maybe: () => ({ listModels: async () => listed }) },
  } as unknown as AgentCtx;
  return new Catalog(ctx);
}

describe("normalizeRef", () => {
  test("stops at a listed id once the speed suffix is gone", () => {
    expect(normalizeRef(ref("plain-high-fast"), [{ id: "plain-high" }])).toEqual({
      provider: "p",
      model: "plain-high",
      fast: true,
    });
    expect(normalizeRef(ref("plain-high-fast"), [{ id: "plain" }, { id: "plain-high" }])).toEqual({
      provider: "p",
      model: "plain-high",
      fast: true,
    });
  });

  test("peels effort only when the speed-stripped id is not listed", () => {
    expect(normalizeRef(ref("plain-high-fast"), [{ id: "plain" }])).toEqual({
      provider: "p",
      model: "plain",
      effort: "high",
      fast: true,
    });
    expect(normalizeRef(ref("plain-high-fast"), [{ id: "other" }])).toEqual(ref("plain-high-fast"));
  });

  test("options already on the ref win over a peeled suffix", () => {
    expect(
      normalizeRef(ref("plain-high-fast", { effort: "low", fast: false }), [{ id: "plain-high" }]),
    ).toEqual(ref("plain-high", { effort: "low", fast: false }));
  });
});

describe("runOptions", () => {
  const listed = [info("a", { efforts: ["low", "high"], defaultEffort: "low", fast: true })];

  test("sends a catalog defaultEffort only when the row overrides the provider", async () => {
    const overridden = await catalog([{ provider: "p", id: "a", defaultEffort: "high" }], listed).info(
      ref("a"),
    );
    expect(runOptions(ref("a"), overridden)).toEqual({ effort: "high" });
    expect(runOptions(ref("a", { effort: "nope" }), overridden)).toEqual({ effort: "high" });
    expect(runOptions(ref("a", { effort: "low" }), overridden)).toEqual({ effort: "low" });

    const same = await catalog([], listed).info(ref("a"));
    expect(runOptions(ref("a"), same)).toEqual({});
    expect(runOptions(ref("a", { effort: "low", fast: false }), same)).toEqual({
      effort: "low",
      fast: false,
    });
  });

  test("omits a row defaultEffort that the model does not list", async () => {
    const merged = await catalog([{ provider: "p", id: "a", defaultEffort: "max" }], listed).info(ref("a"));
    expect(runOptions(ref("a", { effort: "max" }), merged)).toEqual({});
  });

  test("sends a custom model's defaultEffort because the provider has no listing", async () => {
    const custom = await catalog(
      [{ provider: "p", id: "c", custom: true, efforts: ["low", "high"], defaultEffort: "low" }],
      [],
    ).info(ref("c"));
    expect(runOptions(ref("c"), custom)).toEqual({ effort: "low" });
    expect(runOptions(ref("a"), info("a", { efforts: ["low"], defaultEffort: "low" }))).toEqual({});
  });
});

describe("move", () => {
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

  const sessionOf = async (sessionId: string) => k.api(`/api/core/sessions/${sessionId}`);
  const messages = async (
    sessionId: string,
  ): Promise<{ message: Json; parts: { type: string; data: Json }[] }[]> =>
    (await k.api(`/api/core/sessions/${sessionId}/messages`)).body;
  const textOf = (e: { parts: { type: string; data: Json }[] }) =>
    e.parts
      .filter((p) => p.type === "text")
      .map((p) => p.data.text)
      .join("");
  const create = async (projectId: string, extra: Record<string, unknown> = {}): Promise<string> =>
    (await k.api("/api/core/sessions", { method: "POST", body: { projectId, settings: agent, ...extra } }))
      .body.id;
  const send = (sessionId: string, text: string) =>
    k.api(`/api/core/sessions/${sessionId}/messages`, {
      method: "POST",
      body: { role: "user", parts: [{ type: "text", text }] },
    });
  const idle = (sessionId: string) =>
    waitFor(async () => (await sessionOf(sessionId)).body.status === "idle");
  const move = (sessionId: string, projectId: string) =>
    k.api(`/plugins/valet-agent/sessions/${sessionId}/move`, { method: "POST", body: { projectId } });
  const inProject = async (projectId: string): Promise<Json[]> =>
    (await k.api(`/api/core/sessions?projectId=${projectId}`)).body;

  test("moves a session and its subagent tree, copying messages", async () => {
    const parent = await create(projectA, { title: "Chat" });
    await send(parent, "hi");
    await idle(parent);
    await send(parent, "again");
    await idle(parent);
    const child = await create(projectA, { title: "Kid", parentSessionId: parent });
    await send(child, "yo");
    await idle(child);
    const nest = await create(projectA, { title: "Nest", parentSessionId: child });

    const res = await move(parent, projectB);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      projectId: projectB,
      title: "Chat",
      parentSessionId: null,
      settings: { agent: { movedFrom: { sessionId: parent, projectId: projectA } } },
    });
    expect((await messages(res.body.id)).map(textOf)).toEqual(["hi", "Hello, hi", "again", "Hello, again"]);

    const kids = (await inProject(projectB)).filter((s) => s.parentSessionId === res.body.id);
    expect(kids.map((s) => s.title)).toEqual(["Kid"]);
    const kid = kids[0] as Json;
    expect(kid.settings.agent.movedFrom).toEqual({ sessionId: child, projectId: projectA });
    expect((await messages(kid.id)).map(textOf)).toEqual(["yo", "Hello, yo"]);
    const nests = (await inProject(projectB)).filter((s) => s.parentSessionId === kid.id);
    expect(nests.map((s) => s.title)).toEqual(["Nest"]);
    expect((await messages(nests[0].id)).map(textOf)).toEqual([]);

    expect((await sessionOf(parent)).status).toBe(404);
    expect((await sessionOf(child)).status).toBe(404);
    expect((await sessionOf(nest)).status).toBe(404);
  });

  test("drops a child's parent link when the parent stays in the old project", async () => {
    const parent = await create(projectA, { title: "Parent" });
    const child = await create(projectA, { title: "Child", parentSessionId: parent });
    const res = await move(child, projectB);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: projectB, title: "Child", parentSessionId: null });
    expect((await sessionOf(parent)).status).toBe(200);
    expect((await sessionOf(child)).status).toBe(404);
  });

  test("keeps a child's parent link when that parent is already in the destination", async () => {
    const parent = await create(projectB, { title: "There" });
    const child = await create(projectA, { title: "Joining", parentSessionId: parent });
    const res = await move(child, projectB);
    expect(res.status).toBe(200);
    expect(res.body.parentSessionId).toBe(parent);
    expect((await sessionOf(parent)).body.projectId).toBe(projectB);
    expect((await sessionOf(child)).status).toBe(404);
  });

  test("refuses the move while a child is running and leaves the originals", async () => {
    const parent = await create(projectA, { title: "Busy parent" });
    const child = await create(projectA, { title: "Busy child", parentSessionId: parent });
    await send(child, "slow");
    await waitFor(async () => (await sessionOf(child)).body.status === "running");
    const res = await move(parent, projectB);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("a turn is running");
    expect((await sessionOf(parent)).status).toBe(200);
    expect((await sessionOf(child)).body).toMatchObject({ projectId: projectA, parentSessionId: parent });
    expect(
      (await inProject(projectB)).find((s) => s.settings?.agent?.movedFrom?.sessionId === parent),
    ).toBeUndefined();
    await send(child, "/stop");
    await idle(child);
  });

  test("a refused delete midway keeps every chat", async () => {
    const parent = await create(projectA, { title: "Partial" });
    await send(parent, "from-parent");
    await idle(parent);
    const child = await create(projectA, { title: "Partial kid", parentSessionId: parent });
    await send(child, "from-child");
    await idle(child);
    const nest = await create(projectA, { title: "Partial nest", parentSessionId: child });
    await send(nest, "from-nest");
    await idle(nest);
    const block = () =>
      k.api("/plugins/valet-fixture-guard/block-delete", {
        method: "POST",
        body: { sessionId: parent },
      });
    await block();
    try {
      const res = await move(parent, projectB);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("move was partial");

      expect((await messages(parent)).map(textOf)).toEqual(["from-parent", "Hello, from-parent"]);
      expect((await sessionOf(child)).status).toBe(404);
      expect((await sessionOf(nest)).status).toBe(404);

      const copies = (await inProject(projectB)).filter((s) =>
        [child, nest].includes(s.settings?.agent?.movedFrom?.sessionId),
      );
      const kid = copies.find((s) => s.settings.agent.movedFrom.sessionId === child) as Json;
      const grand = copies.find((s) => s.settings.agent.movedFrom.sessionId === nest) as Json;
      expect(kid.title).toBe("Partial kid");
      expect(kid.parentSessionId).toBeNull();
      expect((await messages(kid.id)).map(textOf)).toEqual(["from-child", "Hello, from-child"]);
      expect(grand.parentSessionId).toBe(kid.id);
      expect((await messages(grand.id)).map(textOf)).toEqual(["from-nest", "Hello, from-nest"]);
      expect(
        (await inProject(projectB)).find((s) => s.settings?.agent?.movedFrom?.sessionId === parent),
      ).toBeUndefined();
    } finally {
      await k.api("/plugins/valet-fixture-guard/block-delete", { method: "POST", body: {} });
    }
  });
});
