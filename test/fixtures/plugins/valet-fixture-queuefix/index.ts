import { definePlugin } from "@valethq/sdk";

/** Arms `message.complete` to fail once for one session's assistant message. */
export default definePlugin({
  activate(ctx) {
    const armed = new Map<string, "deny" | "throw">();
    ctx.http.route(
      "POST",
      "/arm",
      async (req) => {
        const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; mode?: unknown };
        if (typeof body.sessionId === "string" && (body.mode === "deny" || body.mode === "throw"))
          armed.set(body.sessionId, body.mode);
        return Response.json({ ok: true });
      },
      { public: true },
    );
    ctx.events.before("message.complete", (e) => {
      const mode = armed.get(e.payload.message.sessionId);
      if (mode === undefined || e.payload.message.role !== "assistant") return;
      armed.delete(e.payload.message.sessionId);
      if (mode === "throw") throw new Error("complete refused");
      e.deny("complete refused");
    });
  },
});
