import { describe, expect, test } from "bun:test";
import type { Caller, RequestContext, RouteAcl, RouteHandler } from "@valethq/sdk";
import type { Env } from "../src/env";
import { registerHttp } from "../src/http";
import type { RunQueue } from "../src/queue";
import { aclParts, callerOf, principals } from "./acl";

interface Route {
  handler: RouteHandler;
  opts: RouteAcl;
}

const sessionFixture = (init: { id: string; projectId: string; parentSessionId?: string | null }) => ({
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
  ...init,
});

function rig(opts: { children?: { id: string; parentSessionId: string }[]; scopes?: object } = {}) {
  const sessions = new Map<string, ReturnType<typeof sessionFixture>>([
    ["ses_1", sessionFixture({ id: "ses_1", projectId: "prj_1" })],
    ...(opts.children ?? []).map((c) => [c.id, sessionFixture({ ...c, projectId: "prj_1" })] as const),
  ]);
  const projects = new Map([["prj_2", { id: "prj_2", name: "beta" }]]);
  let seq = 0;
  const routes = new Map<string, Route>();
  const ctx = {
    ...aclParts,
    ...(opts.scopes === undefined ? {} : { scopes: opts.scopes }),
    config: {},
    store: {
      principals,
      sessions: {
        get: (id: string) => sessions.get(id),
        list: ({ projectId }: { projectId?: string } = {}) =>
          [...sessions.values()].filter((s) => projectId === undefined || s.projectId === projectId),
        create: async (init: { projectId: string; parentSessionId?: string }) => {
          const s = sessionFixture({ ...init, id: `ses_new${++seq}` });
          sessions.set(s.id, s);
          return s;
        },
        update: async (id: string, patch: object) => {
          const s = sessions.get(id);
          return s === undefined
            ? { cancelled: true, cancelReason: "unknown session" }
            : Object.assign(s, patch);
        },
        delete: async (id: string) => {
          const s = sessions.get(id);
          sessions.delete(id);
          return s ?? { cancelled: true, cancelReason: "unknown session" };
        },
      },
      projects: { get: (id: string) => projects.get(id) },
      messages: {
        list: () => [],
        create: async (init: { sessionId: string }) => ({ message: { id: `m${++seq}`, ...init } }),
      },
    },
    http: {
      route: (method: string, path: string, handler: RouteHandler, opts: RouteAcl = {}) =>
        routes.set(`${method} ${path}`, { handler, opts }),
    },
  };
  registerHttp(
    { ctx, catalog: { providers: async () => [] }, lastUsage: new Map() } as unknown as Env,
    { snapshot: () => ({ queued: 0 }) } as unknown as RunQueue,
  );
  const route = (key: string): Route => {
    const found = routes.get(key);
    if (!found) throw new Error(`no route ${key}`);
    return found;
  };
  const call = (key: string, caller: Caller, body: unknown = {}) =>
    route(key).handler(
      new Request("http://x/plugins/valet-agent/sessions/ses_1/move", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { caller, principal: undefined, params: { id: "ses_1" }, url: new URL("http://x/") } as RequestContext,
    );
  return { route, call, routes, sessions };
}

describe("route permissions", () => {
  test("every route declares its permission, none is owner-gated by hand", () => {
    const { route } = rig();
    expect(route("GET /models").opts.permission).toBe("agent:model.read");
    expect(route("POST /sessions/:id/fork").opts.permission).toBe("core:session.write");
    expect(route("POST /sessions/:id/move").opts.permission).toBe("core:session.write");
    expect(route("GET /sessions/:id/state").opts.permission).toBe("core:session.read");
  });

  test("session routes resolve the session from the URL, with its project as ancestor", () => {
    const { route, routes } = rig();
    for (const key of ["POST /sessions/:id/fork", "POST /sessions/:id/move", "GET /sessions/:id/state"]) {
      const resource = route(key).opts.resource;
      expect(resource?.(new Request("http://x/plugins/valet-agent/sessions/ses_1/state"))).toEqual({
        id: "session:ses_1",
        ancestors: ["project:prj_1"],
      });
    }
    expect(routes.get("GET /models")?.opts.resource).toBeUndefined();
  });

  test("the session resource is the router's decoded :id, however the path was written", () => {
    const { route } = rig();
    const resource = route("GET /sessions/:id/state").opts.resource;
    const want = { id: "session:ses_1", ancestors: ["project:prj_1"] };
    expect(resource?.(new Request("http://x/plugins/valet-agent//sessions//ses_1/state"))).toEqual(want);
    expect(resource?.(new Request("http://x/plugins/valet-agent/sessions/ses_%31/state"))).toEqual(want);
  });

  test("move also needs write access to the destination project", async () => {
    const { call } = rig();
    const denied = await call("POST /sessions/:id/move", callerOf("trusted"), { projectId: "prj_2" });
    expect(denied.status).toBe(403);
    const allowed = await call("POST /sessions/:id/move", callerOf("owner"), { projectId: "prj_2" });
    expect(allowed.status).not.toBe(403);
  });

  const scoped = (allowed: string[]) => ({
    maybe: () => ({
      check: (_s: unknown, _p: string, resource?: { id: string }) =>
        resource !== undefined && allowed.includes(resource.id)
          ? { allow: true }
          : { allow: false, by: "test", reason: "not granted" },
    }),
  });

  test("a move is refused when a child session is out of the caller's grant", async () => {
    const { call } = rig({
      children: [{ id: "ses_kid", parentSessionId: "ses_1" }],
      scopes: scoped(["session:ses_1", "project:prj_2"]),
    });
    const res = await call("POST /sessions/:id/move", callerOf("owner"), { projectId: "prj_2" });
    expect(res.status).toBe(403);
  });

  test("a move proceeds when every session in the tree is writable", async () => {
    const { call, sessions } = rig({
      children: [{ id: "ses_kid", parentSessionId: "ses_1" }],
      scopes: scoped(["session:ses_1", "session:ses_kid", "project:prj_2"]),
    });
    const res = await call("POST /sessions/:id/move", callerOf("owner"), { projectId: "prj_2" });
    expect(res.status).toBe(200);
    const moved = (await res.json()) as { id: string; projectId: string };
    expect(moved.projectId).toBe("prj_2");
    expect(sessions.has("ses_1")).toBe(false);
    expect(sessions.has("ses_kid")).toBe(false);
    const child = [...sessions.values()].find((s) => s.id !== moved.id);
    expect(child?.projectId).toBe("prj_2");
    expect(child?.parentSessionId).toBe(moved.id);
  });
});
