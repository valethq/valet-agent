import type { RouteHandler } from "@valethq/sdk";
import type { Env } from "./env";
import { forkSession } from "./fork";
import { resolveModel } from "./model";
import { moveSession } from "./move";
import type { RunQueue } from "./queue";

const ownerOnly =
  (handler: RouteHandler): RouteHandler =>
  (req, ctx) =>
    ctx.principal?.role === "owner"
      ? handler(req, ctx)
      : Response.json({ error: { code: "denied", reason: "owner only" } }, { status: 403 });

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

  ctx.http.route(
    "GET",
    "/models",
    ownerOnly(async () => Response.json({ providers: await env.catalog.providers() })),
  );

  const storeOf = (principalId: string | undefined) =>
    principalId ? ctx.store.as({ principalId }) : ctx.store;

  ctx.http.route(
    "POST",
    "/sessions/:id/fork",
    ownerOnly(async (req, { params, principal }) => {
      const { messageId } = await bodyOf(req);
      if (messageId !== undefined && typeof messageId !== "string")
        return failed(new Error("messageId must be a string"));
      try {
        const session = await forkSession(storeOf(principal?.id), params.id as string, messageId);
        return Response.json(session, { status: 201 });
      } catch (error) {
        return failed(error);
      }
    }),
  );

  ctx.http.route(
    "POST",
    "/sessions/:id/move",
    ownerOnly(async (req, { params, principal }) => {
      const { projectId } = await bodyOf(req);
      if (typeof projectId !== "string") return failed(new Error("projectId is required"));
      const id = params.id as string;
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
    }),
  );

  ctx.http.route(
    "GET",
    "/sessions/:id/state",
    ownerOnly((_req, { params }) => {
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
    }),
  );
}
