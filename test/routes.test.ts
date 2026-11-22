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

function rig() {
  const routes = new Map<string, Route>();
  const ctx = {
    ...aclParts,
    config: {},
    store: {
      principals,
      sessions: { get: (id: string) => (id === "ses_1" ? { id, projectId: "prj_1" } : undefined) },
      projects: { get: () => undefined },
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
  return { route, call, routes };
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

  test("move also needs write access to the destination project", async () => {
    const { call } = rig();
    const denied = await call("POST /sessions/:id/move", callerOf("trusted"), { projectId: "prj_2" });
    expect(denied.status).toBe(403);
    const allowed = await call("POST /sessions/:id/move", callerOf("owner"), { projectId: "prj_2" });
    expect(allowed.status).not.toBe(403);
  });
});
