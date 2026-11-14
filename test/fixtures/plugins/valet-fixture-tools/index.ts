import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    ctx.events.before("tool.call", (e) => {
      const input = e.payload.input as { deny?: boolean; rewrite?: boolean } | undefined;
      if (input?.deny === true) e.deny("fixture says no");
      if (input?.rewrite === true) e.payload = { ...e.payload, input: { rewritten: true } };
    });
    ctx.scopes.provide("tools", {
      list: () => [
        {
          name: "echo",
          description: "Echoes its input",
          inputSchema: { type: "object" },
          invoke: async (input) => ({ content: [{ type: "text", text: `echo:${JSON.stringify(input)}` }] }),
        },
      ],
    });
  },
});
