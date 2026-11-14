# valet-agent

Run queue, provider bridging, fallbacks and slash commands.

A [valet](https://github.com/valethq/valet-core) plugin. Imports `@valethq/sdk` only.

## Tools for providers

Valet's `tools@1` tools reach every provider through a `ToolSurface` (SDK `ToolSurface`). Agent providers get it in `open()` as `opts.tools`; model providers get the tool specs in each request. The surface is bound to the session: `list()` and `call()` follow the run that is active. `valet-agent` filters the list by the run's role and by `exposedTools`, and runs the `tool.call` gate inside `call()`, so providers never enforce policy. How a provider exposes its surface is the provider's choice. `valet-claudecode` and `valet-devin` mount it as an MCP server on their own route with the SDK's `toolEndpoint` helper.

Config: `exposedTools` (array of tool names). Unset exposes everything the run's role allows.

## Sessions

- **Subagents.** The `subagent` tool (owner runs only) starts a child session (`parentSessionId` = the calling chat) in the same project, runs one turn there with the caller's run role, and returns the reply and the child's session id. Pass `session` to send that child a follow-up. Nesting stops at 3 levels.
- **Fork.** `POST /plugins/valet-agent/sessions/:id/fork` with an optional `{ messageId }`, or `/fork [messageId]` in the chat. Copies the chat up to and including that message (default: the latest) into a new session in the same project. Copies never start runs.
- **Move.** `POST /plugins/valet-agent/sessions/:id/move` with `{ projectId }`, or `/move <project name or id>`. The SDK can't change a session's project, so this copies the chat into a new session in the target project and deletes the original. The moved session gets a new id, and runs, channel bindings and child links stay behind. Refused while a turn is running.
- A harness session that starts fresh in a chat with earlier turns (fork, move, reseed) gets the transcript since the last valet summary in its first prompt.
