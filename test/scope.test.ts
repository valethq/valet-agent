import { describe, expect, test } from "bun:test";
import {
  AgentOperationError,
  type AgentRuntime,
  type Caller,
  type Project,
  ServiceDeniedError,
  type Session,
  type Store,
} from "@valethq/sdk";
import type { Env } from "../src/env";
import type { RunQueue } from "../src/queue";
import { provideAgent } from "../src/scope";
import { aclParts, callerOf, principalOf, principals } from "./acl";

const session = (id: string, projectId = "prj_1"): Session => ({
  id,
  projectId,
  title: null,
  color: null,
  parentSessionId: null,
  status: "idle",
  settings: {},
  providerState: {},
  createdAt: 1,
  updatedAt: 1,
  lastMessageAt: null,
  lastResponseAt: null,
});

interface Rig {
  runtime(caller: Caller): AgentRuntime;
  defined: { name: string; version: number; cardinality: string }[];
  /** Principals passed to `store.as`. */
  actingAs: string[];
  messages: { role: string }[];
  snapshot: { activeRunId?: string; queued: number };
}

function rig(opts: { messages?: number } = {}): Rig {
  const rigged: Partial<Rig> & { factory?: (caller: Caller) => AgentRuntime } = {
    defined: [],
    actingAs: [],
    messages: [],
    snapshot: { queued: 0 },
  };
  const sessions = new Map([
    ["ses_1", session("ses_1")],
    ["ses_kid", session("ses_kid")],
  ]);
  const projects = new Map<string, Project>([
    ["prj_1", { id: "prj_1", name: "a", settings: {} } as Project],
    ["prj_2", { id: "prj_2", name: "b", settings: {} } as Project],
  ]);
  const store = {
    principals,
    sessions: {
      get: (id: string) => sessions.get(id),
      list: () => [...sessions.values()],
      create: async (init: { projectId: string }) => session("ses_new", init.projectId),
      update: async () => undefined,
      delete: async (id: string) => {
        const gone = sessions.delete(id);
        return gone ? session(id) : { cancelled: true, cancelReason: "unknown session" };
      },
    },
    projects: { get: (id: string) => projects.get(id) },
    messages: {
      list: () =>
        rigged.messages?.map((_m, i) => ({
          message: { id: `msg_${i}`, seq: i + 1, sessionId: "ses_1", meta: {}, parts: [] },
          parts: [],
        })),
      create: async (init: { role: string }) => {
        rigged.messages?.push({ role: init.role });
        return { message: { id: `msg_${rigged.messages?.length}` }, parts: [] };
      },
      complete: async () => undefined,
    },
  } as unknown as Store;
  const ctx = {
    ...aclParts,
    config: {},
    store: {
      ...store,
      as: (actor: { principalId: string }) => {
        rigged.actingAs?.push(actor.principalId);
        return store;
      },
    },
    paths: { data: "/tmp" },
    scopes: {
      ...aclParts.scopes,
      define: (def: { name: string; version: number; cardinality: string }) => rigged.defined?.push(def),
      provide: (_name: string, impl: unknown) => {
        rigged.factory = impl as (caller: Caller) => AgentRuntime;
      },
      get: () => ({}),
      all: () => [],
      maybe: (name: string) =>
        name === "inference" ? { kind: "agent", label: "Fake", listModels: async () => [] } : undefined,
    },
  };
  for (let i = 0; i < (opts.messages ?? 1); i++) rigged.messages?.push({ role: "user" });
  const env = {
    ctx,
    agents: { acquire: async () => ({ session: {} }), drop: async () => undefined },
    catalog: { providers: async () => [], normalize: (ref: unknown) => ref, info: async () => ({}) },
    lastUsage: new Map(),
  } as unknown as Env;
  const queue = {
    snapshot: () => rigged.snapshot,
    beginCompact: async () => () => undefined,
  } as unknown as RunQueue;
  provideAgent(env, queue);
  rigged.runtime = (caller) => (rigged.factory as (caller: Caller) => AgentRuntime)(caller);
  return rigged as Rig;
}

const subject = (role: "owner" | "guest" = "owner") => ({
  actor: { principalId: principalOf(role), role },
});
const owner = () => callerOf("owner");

describe("agent@1 provider", () => {
  test("defines and provides agent@1 as a single provider", () => {
    const rigged = rig();
    expect(rigged.defined).toEqual([{ name: "agent", version: 1, cardinality: "one" }]);
    expect(rigged.runtime(owner())).toBeDefined();
  });

  test("state answers the queue and model, and undefined for an unknown session", () => {
    const rigged = rig();
    rigged.snapshot = { activeRunId: "run_1", queued: 2 };
    const impl = rigged.runtime(owner());
    expect(impl.state("ses_1")).toEqual({
      activeRunId: "run_1",
      queued: 2,
      model: { provider: "devin-cli", model: "claude-opus-5-5", effort: "medium" },
    });
    expect(impl.state("ses_missing")).toBeUndefined();
  });

  test("fork acts for the subject principal and denies one without write", async () => {
    const rigged = rig();
    const allowed = await rigged.runtime(owner()).fork("ses_1", { subject: subject() });
    expect(allowed.projectId).toBe("prj_1");
    expect(rigged.actingAs).toEqual([principalOf("owner")]);

    await expect(rigged.runtime(owner()).fork("ses_1", { subject: subject("guest") })).rejects.toBeInstanceOf(
      ServiceDeniedError,
    );
  });

  test("fork reports an empty chat as not_found", async () => {
    const error = await rig({ messages: 0 })
      .runtime(owner())
      .fork("ses_1", { subject: subject() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentOperationError);
    expect((error as AgentOperationError).code).toBe("not_found");
  });
});

describe("agent@1 move", () => {
  test("a busy session maps to busy", async () => {
    const rigged = rig();
    rigged.snapshot = { activeRunId: "run_1", queued: 0 };
    const error = await rigged
      .runtime(owner())
      .move("ses_1", "prj_2", { subject: subject() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentOperationError);
    expect((error as AgentOperationError).code).toBe("busy");
  });

  test("an unknown project is not_found, and moving where it already is is bad_request", async () => {
    const impl = rig().runtime(owner());
    const missing = await impl.move("ses_1", "prj_nope", { subject: subject() }).catch((e: unknown) => e);
    expect((missing as AgentOperationError).code).toBe("not_found");
    const same = await impl.move("ses_1", "prj_1", { subject: subject() }).catch((e: unknown) => e);
    expect((same as AgentOperationError).code).toBe("bad_request");
  });

  test("a subject without write is denied", async () => {
    await expect(
      rig()
        .runtime(owner())
        .move("ses_1", "prj_2", { subject: subject("guest") }),
    ).rejects.toBeInstanceOf(ServiceDeniedError);
  });
});

describe("agent@1 compact", () => {
  test("an unsupported provider is its own code", async () => {
    const error = await rig()
      .runtime(owner())
      .compact("ses_1", { subject: subject() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentOperationError);
    expect((error as AgentOperationError).code).toBe("unsupported");
  });

  test("an unknown session is not_found and a running turn is busy", async () => {
    const rigged = rig();
    const impl = rigged.runtime(owner());
    const missing = await impl.compact("ses_nope", { subject: subject() }).catch((e: unknown) => e);
    expect((missing as AgentOperationError).code).toBe("not_found");
    rigged.snapshot = { activeRunId: "run_1", queued: 0 };
    const busy = await impl.compact("ses_1", { subject: subject() }).catch((e: unknown) => e);
    expect((busy as AgentOperationError).code).toBe("busy");
  });

  test("compact is denied for a subject without write", async () => {
    await expect(
      rig()
        .runtime(owner())
        .compact("ses_1", { subject: subject("guest") }),
    ).rejects.toBeInstanceOf(ServiceDeniedError);
  });
});
