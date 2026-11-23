import { sessionResource } from "@valethq/sdk";
import type { Env } from "./env";
import { forkSession } from "./fork";
import { resolveModel } from "./model";
import { moveDenied, moveSession } from "./move";
import type { RunQueue } from "./queue";

/** The `:id` core's router hands the handler: the decoded segment before the verb. */
const sessionIdOf = (req: Request): string => {
  const raw =
    new URL(req.url).pathname
      .split("/")
      .filter((s) => s !== "")
      .at(-2) ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const failed = (error: unknown): Response => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /^unknown (session|message|project)$/.test(message) ? 404 : 400;
  return Response.json(
    { error: { code: status === 404 ? "not_found" : "bad_request", message } },
    { status },
  );
};

const bodyOf = async (req: Request): Promise<Record<string, unknown>> => {
  const body = (await req.json().catch(() => ({}))) as unknown;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
};

export function registerHttp(env: Env, queue: RunQueue): void {
  const { ctx } = env;

  ctx.http.route("GET", "/models", async () => Response.json({ providers: await env.catalog.providers() }), {
    permission: "agent:model.read",
  });

  const resourceOf = (req: Request) => sessionResource(ctx, sessionIdOf(req));

  const storeOf = (principalId: string | undefined) =>
    principalId ? ctx.store.as({ principalId }) : ctx.store;

  ctx.http.route(
    "POST",
    "/sessions/:id/fork",
    async (req, { params, principal }) => {
      const { messageId } = await bodyOf(req);
      if (messageId !== undefined && typeof messageId !== "string")
        return failed(new Error("messageId must be a string"));
      try {
        const session = await forkSession(storeOf(principal?.id), params.id as string, messageId);
        return Response.json(session, { status: 201 });
      } catch (error) {
        return failed(error);
      }
    },
    { permission: "core:session.write", resource: resourceOf },
  );

  ctx.http.route(
    "POST",
    "/sessions/:id/move",
    async (req, { params, principal, caller }) => {
      const { projectId } = await bodyOf(req);
      if (typeof projectId !== "string") return failed(new Error("projectId is required"));
      const id = params.id as string;
      const source = ctx.store.sessions.get(id);
      if (!source) return failed(new Error("unknown session"));
      const denied = moveDenied(ctx, caller, ctx.store, source, projectId);
      if (denied) return Response.json({ error: { code: "denied", reason: denied.reason } }, { status: 403 });
      const { activeRunId, queued } = queue.snapshot(id);
      try {
        const session = await moveSession(
          storeOf(principal?.id),
          id,
          projectId,
          activeRunId !== undefined || queued > 0,
        );
        return Response.json(session);
      } catch (error) {
        return failed(error);
      }
    },
    { permission: "core:session.write", resource: resourceOf },
  );

  ctx.http.route(
    "GET",
    "/sessions/:id/state",
    (_req, { params }) => {
      const id = params.id as string;
      const session = ctx.store.sessions.get(id);
      if (!session)
        return Response.json({ error: { code: "not_found", message: "unknown session" } }, { status: 404 });
      const usage = env.lastUsage.get(id);
      return Response.json({
        ...queue.snapshot(id),
        model: env.catalog.normalize(
          resolveModel(session, ctx.store.projects.get(session.projectId), ctx.config),
        ),
        ...(usage ? { usage } : {}),
      });
    },
    { permission: "core:session.read", resource: resourceOf },
  );
}
