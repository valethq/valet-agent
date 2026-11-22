import { type Caller, definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    const seen = {
      listed: [] as (Caller | undefined)[],
      invoked: [] as Caller[],
      hooked: [] as Caller[],
    };
    ctx.http.route("GET", "/seen", () => Response.json(seen), { public: true });
    ctx.events.before("tool.call", (e) => {
      seen.hooked.push(e.caller);
      const input = e.payload.input as { deny?: boolean; rewrite?: boolean } | undefined;
      if (input?.deny === true) e.deny("fixture says no");
      if (input?.rewrite === true) e.payload = { ...e.payload, input: { rewritten: true } };
    });
    ctx.scopes.provide("tools", {
      list: (scope) => {
        seen.listed.push(scope.caller);
        return [
          {
            name: "echo",
            description: "Echoes its input",
            inputSchema: { type: "object" },
            invoke: async (input, call) => {
              seen.invoked.push(call.caller);
              return { content: [{ type: "text", text: `echo:${JSON.stringify(input)}` }] };
            },
          },
        ];
      },
    });
  },
});
