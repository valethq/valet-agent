import type { RouteHandler } from "@valethq/sdk";
import type { Env } from "./env";
import { configFor, resolveModel } from "./model";
import type { RunQueue } from "./queue";

const ownerOnly =
  (handler: RouteHandler): RouteHandler =>
  (req, ctx) =>
    ctx.principal?.role === "owner"
      ? handler(req, ctx)
      : Response.json({ error: { code: "denied", reason: "owner only" } }, { status: 403 });

export function registerHttp(env: Env, queue: RunQueue): void {
  const { ctx } = env;

  ctx.http.route(
    "GET",
    "/models",
    ownerOnly(async () => {
      const providers = await Promise.all(
        ctx.scopes.all("inference").map(async ({ key, impl }) => {
          try {
            return { provider: key, kind: impl.kind, models: await impl.listModels() };
          } catch (error) {
            return { provider: key, kind: impl.kind, models: [], error: String(error) };
          }
        }),
      );
      return Response.json({ providers });
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
        model: resolveModel(session, ctx.store.projects.get(session.projectId), configFor(ctx)),
        ...(usage ? { usage } : {}),
      });
    }),
  );
}
