import { definePlugin, defineScope, type ModelMessage } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    ctx.scopes.define(defineScope({ name: "context", version: 1, cardinality: "one" }));
    const impl = {
      async build(req: { sessionId: string }) {
        const messages: ModelMessage[] = [];
        for (const { message, parts } of ctx.store.messages.list(req.sessionId)) {
          const text = parts.flatMap((p) => (p.data.type === "text" ? [p.data.text] : [])).join("");
          if (message.role === "user" || (message.role === "assistant" && text)) {
            messages.push({ role: message.role, content: [{ type: "text", text }] });
          }
        }
        return { system: "fixture system", messages, estimatedTokens: 0, files: [] };
      },
      async preamble() {
        return "PREAMBLE";
      },
      async shouldCompact() {
        return false;
      },
      async compact(): Promise<{ summaryPartId: string }> {
        throw new Error("compaction not implemented");
      },
    };
    ctx.scopes.provide("context", impl as never, { key: "valet-contextmanager" });
  },
});
