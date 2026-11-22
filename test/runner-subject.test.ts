import { describe, expect, test } from "bun:test";
import type { RunSubject } from "@valethq/sdk";
import { execute, type Job } from "../src/runner";

function harness() {
  const created: unknown[] = [];
  const as: unknown[] = [];
  const callerFor: string[] = [];
  const runs = new Map<string, { id: string; status: string }>();
  const store: Record<string, unknown> = {
    sessions: { get: (id: string) => (id === "ses" ? { id, projectId: "prj", settings: {} } : undefined) },
    projects: { get: () => undefined },
    runs: {
      create: (r: unknown) => {
        created.push(r);
        runs.set("run1", { id: "run1", status: "queued" });
        return { id: "run1" };
      },
      update: (id: string, patch: object) => Object.assign(runs.get(id) ?? {}, patch),
      get: (id: string) => runs.get(id),
      caller: (id: string) => {
        callerFor.push(id);
        return { plugin: "valet-agent", actor: { principalId: "owner", role: "owner", runId: id } };
      },
    },
    messages: {
      create: async () => ({ message: { id: "asst" } }),
      openPart: () => ({ partId: "p", append() {}, replace() {}, close() {} }),
      complete: async () => {},
      list: () => [],
    },
    as: (actor: unknown) => {
      as.push(actor);
      return store;
    },
  };
  const env = {
    ctx: {
      store,
      config: {},
      signal: new AbortController().signal,
      plugin: { id: "valet-agent" },
      paths: { data: "/tmp" },
      log: { warn() {}, error() {}, info() {} },
    },
    catalog: {
      normalize() {
        throw new Error("stop here");
      },
    },
    lastUsage: new Map(),
  };
  const jobFor = (subject: RunSubject): Job =>
    ({
      sessionId: "ses",
      message: { id: "msg", seq: 1 },
      parts: [],
      role: "trusted",
      subject,
    }) as unknown as Job;
  const run = (job: Job) =>
    execute(env as never, job, { controller: new AbortController(), messageId: "msg" });
  return { created, as, callerFor, run, jobFor };
}

describe("execute and the run's subject", () => {
  test("the run is created with the job's subject and acts as its principal and run", async () => {
    const h = harness();
    const subject: RunSubject = { principalId: "owner", cap: ["agent:*"], originRunId: "run0" };
    await h.run(h.jobFor(subject));
    expect(h.created).toEqual([{ sessionId: "ses", triggerMessageId: "msg", role: "trusted", subject }]);
    expect(h.as).toEqual([{ principalId: "owner" }, { principalId: "owner", runId: "run1" }]);
    expect(h.callerFor).toEqual(["run1"]);
  });

  test("a subject without a principal acts as the plugin", async () => {
    const h = harness();
    await h.run(h.jobFor({ principalId: null }));
    expect(h.as).toEqual([]);
    expect(h.created).toHaveLength(1);
  });

  test("tier-based code sees the run's stored role, not the requested one", async () => {
    // core lowers run.role to the audience; context build and tool listing must follow it, not job.role.
    const seen: { build?: string; list?: string } = {};
    const store: Record<string, unknown> = {
      sessions: {
        get: (id: string) => (id === "ses" ? { id, projectId: "prj", settings: {} } : undefined),
      },
      projects: { get: () => undefined },
      runs: {
        create: () => ({ id: "run1", role: "guest" }),
        update: () => {},
        get: () => ({ id: "run1", status: "running" }),
        caller: () => ({ plugin: "valet-agent" }),
      },
      messages: {
        create: async () => ({ message: { id: "asst" } }),
        openPart: () => ({ partId: "p", append() {}, replace() {}, close() {} }),
        complete: async () => {},
        list: () => [],
      },
      as: () => store,
    };
    const env = {
      ctx: {
        store,
        config: {},
        signal: new AbortController().signal,
        plugin: { id: "valet-agent" },
        paths: { data: "/tmp" },
        log: { warn() {}, error() {}, info() {} },
        acl: { permission: () => ({ summary: "x" }), credential: () => undefined },
        events: { emit: async (_n: string, p: unknown) => ({ payload: p, cancelled: false }) },
        scopes: {
          maybe: () => ({
            kind: "model",
            id: "p",
            label: "p",
            listModels: async () => [],
            stream: async function* () {
              yield { type: "finish", reason: "stop" };
            },
          }),
          get: () => ({
            build: async (req: { role: string }) => {
              seen.build = req.role;
              return { system: "", messages: [], estimatedTokens: 0, files: [] };
            },
            shouldCompact: async () => false,
          }),
          all: () => [
            {
              impl: {
                list: (scope: { role: string }) => {
                  seen.list = scope.role;
                  return [];
                },
              },
            },
          ],
        },
      },
      catalog: {
        normalize: (r: unknown) => r,
        info: async () => ({
          id: "m",
          name: "m",
          contextWindow: 1000,
          maxOutputTokens: 100,
          input: ["text"],
          reasoning: false,
        }),
      },
      agents: { drop: async () => {} },
      lastUsage: new Map(),
      ownTools: () => [],
    };
    const job = {
      sessionId: "ses",
      message: { id: "msg", seq: 1 },
      parts: [],
      role: "owner",
      subject: { principalId: "p-owner" },
    } as unknown as Job;
    await execute(env as never, job, { controller: new AbortController(), messageId: "msg" });
    expect(seen.build).toBe("guest");
    expect(seen.list).toBe("guest");
  });
});
