# valet-agent

Run queue, provider bridging, fallbacks and slash commands.

A [valet](https://github.com/valethq/valet-core) plugin. Imports `@valethq/sdk` only.

## Tools for providers

Valet's `tools@1` tools reach every provider through a `ToolSurface` (SDK `ToolSurface`). Agent providers get it in `open()` as `opts.tools`; model providers get the tool specs in each request. The surface is bound to the session: `list()` and `call()` follow the run that is active. `valet-agent` filters the list by the run's role and by `exposedTools`, and runs the `tool.call` gate inside `call()`, so providers never enforce policy. How a provider exposes its surface is the provider's choice. `valet-claudecode` and `valet-devin` mount it as an MCP server on their own route with the SDK's `toolEndpoint` helper.

Config: `exposedTools` (array of tool names). Unset exposes everything the run's role allows.

## Sessions

- **Model catalog.** `GET /models` merges every provider's `listModels()` with the `models` rows in this plugin's config (11.1): overrides of a listed model (`name`, `contextWindow`, `maxOutputTokens`, `efforts`, `defaultEffort`, `fast`), `show` to keep a model in or out of pickers, `{ "id": "*", "show": false }` to make a provider's list an allowlist, and `custom: true` rows for models the provider doesn't list. Each entry carries `show`, `custom` and the provider's own values as `base`.
- **Model options.** A model ref is `{ provider, model, effort?, fast? }`. Runs pass the options to the provider only when the catalog says the model takes them. Refs from before options (`claude-opus-5-5-high`, `swe-2-medium-lightning`) are read as model plus options, and rewritten in sessions and projects once at boot. `/model [provider:]model [effort] [fast|standard]` and the subagent tool's `model` take the same words.
- **Settings** are this plugin's config (12.1): `defaultModel`, `models`, `queueMode`, `presentConfine`, `presentRoots`, `exposedTools`. The UI edits them through core; there is no settings panel.
- **Subagents.** The `subagent` tool (owner runs only) takes `tasks`, an array of up to 8 `{ prompt, title?, stage?, session?, model? }`. Each new task becomes a child session (`parentSessionId` = the calling chat, `settings.agent.parentRunId` = the calling run, `settings.agent.stage`) in the same project and runs one turn with the caller's run role. With no `stage` every task runs at once. Tasks sharing a stage number run together and a stage starts only after the one before it has finished (stages need not be contiguous). The call waits for all of them and returns each reply plus its session id; pass an id as a task's `session` to send that child a follow-up. Nesting stops at 3 levels. A later stage does not see earlier replies; the model does, and can pass them on in the next call.
- **Fork.** `POST /plugins/valet-agent/sessions/:id/fork` with an optional `{ messageId }`, or `/fork [messageId]` in the chat. Copies the chat up to and including that message (default: the latest) into a new session in the same project. Copies never start runs.
- **Move.** `POST /plugins/valet-agent/sessions/:id/move` with `{ projectId }`, or `/move <project name or id>`. The SDK can't change a session's project, so this copies the chat into a new session in the target project and deletes the original. The moved session gets a new id, and runs, channel bindings and child links stay behind. Refused while a turn is running.
- A harness session that starts fresh in a chat with earlier turns (fork, move, reseed) gets the transcript since the last valet summary in its first prompt.
