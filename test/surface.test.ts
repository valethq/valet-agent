import { describe, expect, test } from "bun:test";
import type { PluginContext, ToolDefinition } from "@valethq/sdk";
import type { AgentConfig } from "../src/model";
import type { RunCtx } from "../src/run-types";
import { ToolRouter } from "../src/surface";

const tool = (name: string): ToolDefinition => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" },
  invoke: async () => ({ content: [{ type: "text", text: name }] }),
});

function fakeCtx(
  config: AgentConfig,
  tools: ToolDefinition[],
  verdict?: { denied?: string; rewrite?: unknown },
) {
  return {
    config,
    storage: { kv: { get: () => undefined } },
    scopes: { all: () => [{ key: "fake", plugin: "fake", impl: { list: () => tools } }] },
    events: {
      emit: async (_: string, payload: { input: unknown }) =>
        verdict?.denied !== undefined
          ? { payload, cancelled: true, denied: { by: "policy", reason: verdict.denied } }
          : {
              payload: verdict?.rewrite !== undefined ? { ...payload, input: verdict.rewrite } : payload,
              cancelled: false,
            },
    },
  } as unknown as PluginContext<AgentConfig>;
}

const own = () => [tool("present")];

const runFor = (sessionId: string): RunCtx =>
  ({
    sessionId,
    projectId: "prj",
    cwd: "/tmp",
    runId: "run_1",
    role: "owner",
    caller: { plugin: "valet-agent" },
    signal: new AbortController().signal,
  }) as unknown as RunCtx;

describe("ToolRouter", () => {
  test("with no exposure config, every tool the run gets is listed", async () => {
    const router = new ToolRouter(fakeCtx({}, [tool("echo"), tool("shell")]), own);
    await router.enter(runFor("ses_1"));
    expect(
      router
        .surface("ses_1")
        .list()
        .map((t) => t.name),
    ).toEqual(["echo", "shell", "present"]);
  });

  test("exposedTools narrows the list and the callable set", async () => {
    const router = new ToolRouter(fakeCtx({ exposedTools: ["echo"] }, [tool("echo"), tool("shell")]), own);
    await router.enter(runFor("ses_1"));
    const surface = router.surface("ses_1");
    expect(surface.list().map((t) => t.name)).toEqual(["echo"]);
    const refused = await surface.call("shell", {}, { callId: "c", signal: new AbortController().signal });
    expect(refused.isError).toBe(true);
  });

  test("outside a run the list is empty and calls are refused", async () => {
    const router = new ToolRouter(fakeCtx({}, [tool("echo")]), own);
    const surface = router.surface("ses_1");
    expect(surface.list()).toEqual([]);
    const res = await surface.call("echo", {}, { callId: "c", signal: new AbortController().signal });
    expect(res).toEqual({
      content: [{ type: "text", text: "no valet run is active for this session" }],
      isError: true,
    });
  });

  test("leave ends the run's access; a later run's enter restores it", async () => {
    const router = new ToolRouter(fakeCtx({}, [tool("echo")]), own);
    const rc = runFor("ses_1");
    await router.enter(rc);
    router.leave(rc);
    expect(router.surface("ses_1").list()).toEqual([]);
  });

  test("authorize returns the gate's verdict for a call the provider runs itself", async () => {
    const denying = new ToolRouter(fakeCtx({}, [], { denied: "no shell for you" }), own);
    await denying.enter(runFor("ses_1"));
    expect(await denying.surface("ses_1").authorize("Bash", { command: "rm" }, { callId: "c" })).toEqual({
      denied: "no shell for you",
    });

    const rewriting = new ToolRouter(fakeCtx({}, [], { rewrite: { command: "echo safe" } }), own);
    await rewriting.enter(runFor("ses_1"));
    expect(await rewriting.surface("ses_1").authorize("Bash", { command: "rm" }, { callId: "c" })).toEqual({
      input: { command: "echo safe" },
    });
  });

  test("authorize outside a run is a denial", async () => {
    const router = new ToolRouter(fakeCtx({}, []), own);
    expect(await router.surface("ses_1").authorize("Bash", {}, { callId: "c" })).toEqual({
      denied: "no valet run is active for this session",
    });
  });
});
