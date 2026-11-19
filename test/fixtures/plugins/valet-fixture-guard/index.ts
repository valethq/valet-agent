import { definePlugin } from "@valethq/sdk";

/** Test hook: POST /block-delete { sessionId } makes session.delete of that id cancel. */
export default definePlugin({
  activate(ctx) {
    let block: string | undefined;
    ctx.http.route(
      "POST",
      "/block-delete",
      async (req) => {
        const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
        block = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined;
        return Response.json({ ok: true });
      },
      { public: true },
    );
    ctx.events.before("session.delete", (e) => {
      if (e.payload.session.id === block) e.cancel("fixture refused this delete");
    });
  },
});
