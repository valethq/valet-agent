# valet-agent

Run queue, provider bridging, fallbacks and slash commands.

A [valet](https://github.com/valethq/valet-core) plugin. Imports `@valethq/sdk` only.

## Tools for providers

Valet's `tools@1` tools reach every provider through a `ToolSurface` (SDK `ToolSurface`). Agent providers get it in `open()` as `opts.tools`; model providers get the tool specs in each request. The surface is bound to the session: `list()` and `call()` follow the run that is active. `valet-agent` filters the list by the run's role and by `exposedTools`, and runs the `tool.call` gate inside `call()`, so providers never enforce policy. How a provider exposes its surface is the provider's choice. `valet-claudecode` and `valet-devin` mount it as an MCP server on their own route with the SDK's `toolEndpoint` helper.

Config: `exposedTools` (array of tool names). Unset exposes everything the run's role allows.
