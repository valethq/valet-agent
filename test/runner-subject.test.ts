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
});
