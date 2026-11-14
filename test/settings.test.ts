import { expect, test } from "bun:test";
import type { PluginContext, SettingsPanel } from "@valethq/sdk";
import type { AgentConfig } from "../src/model";
import { configFor } from "../src/model";
import { defaultQueueMode, presentConfined, presentRoots, registerSettings } from "../src/settings";

/** The panels under test have a form, so get and set are present. */
type FormPanel = SettingsPanel & Required<Pick<SettingsPanel, "get" | "set">>;

function kvCtx(config: AgentConfig = {}) {
  const kv = new Map<string, unknown>();
  const panels: { key?: string; impl: FormPanel }[] = [];
  const ctx = {
    config,
    storage: {
      kv: {
        get: <T>(k: string) => kv.get(k) as T | undefined,
        set: (k: string, v: unknown) => void kv.set(k, v),
        delete: (k: string) => void kv.delete(k),
        list: () => [...kv.keys()],
      },
    },
    scopes: {
      define: () => {},
      provide: (_s: string, impl: SettingsPanel, opts?: { key?: string }) => {
        panels.push({ key: opts?.key, impl: impl as FormPanel });
        return { dispose() {} };
      },
    },
  } as unknown as PluginContext<AgentConfig>;
  return { ctx, kv, panels };
}

test("configFor: kv model wins over config.defaultModel", () => {
  const { ctx, kv } = kvCtx({ defaultModel: { provider: "a", model: "m1" } });
  expect(configFor(ctx).defaultModel).toEqual({ provider: "a", model: "m1" });
  kv.set("defaultModel", { provider: "b", model: "m2" });
  expect(configFor(ctx).defaultModel).toEqual({ provider: "b", model: "m2" });
  kv.set("defaultModel", { provider: 1 });
  expect(configFor(ctx).defaultModel).toEqual({ provider: "a", model: "m1" });
});

test("defaultQueueMode: kv wins over queue, bad values fall back", () => {
  const { ctx, kv } = kvCtx();
  expect(defaultQueueMode(ctx)).toBe("queue");
  kv.set("defaultQueueMode", "interrupt");
  expect(defaultQueueMode(ctx)).toBe("interrupt");
  kv.set("defaultQueueMode", "steer");
  expect(defaultQueueMode(ctx)).toBe("queue");
});

test("panel get/set round-trips and validates", async () => {
  const { ctx, kv, panels } = kvCtx();
  registerSettings(ctx);
  const p = panels[0];
  expect(p?.key).toBe("valet-agent");
  expect(await p?.impl.get()).toEqual({
    defaultQueueMode: "",
    defaultProvider: "",
    defaultModel: "",
    presentConfine: true,
    presentRoots: [],
  });
  await p?.impl.set({ defaultQueueMode: "interrupt", defaultProvider: "devin-cli", defaultModel: "m9" });
  expect(kv.get("defaultQueueMode")).toBe("interrupt");
  expect(kv.get("defaultModel")).toEqual({ provider: "devin-cli", model: "m9" });
  // blank model fields clear the override
  await p?.impl.set({ defaultQueueMode: "queue", defaultProvider: "", defaultModel: "" });
  expect(kv.has("defaultModel")).toBe(false);
  // half a model is an error
  expect(() =>
    p?.impl.set({ defaultQueueMode: "queue", defaultProvider: "devin-cli", defaultModel: "" }),
  ).toThrow("together");
  expect(() => p?.impl.set({ defaultQueueMode: "steer", defaultProvider: "", defaultModel: "" })).toThrow(
    "defaultQueueMode",
  );
});

test("present settings: stored values beat config.json, defaults are confined, bad values are rejected", async () => {
  const { ctx, kv, panels } = kvCtx({ presentConfine: false, presentRoots: ["/cfg"] });
  expect(presentConfined(ctx)).toBe(false);
  expect(presentRoots(ctx)).toEqual(["/cfg"]);
  expect(presentConfined(kvCtx().ctx)).toBe(true);

  registerSettings(ctx);
  const p = panels[0];
  const base = { defaultQueueMode: "queue", defaultProvider: "", defaultModel: "" };
  await p?.impl.set({ ...base, presentConfine: true, presentRoots: [" /srv/out ", ""] });
  expect(kv.get("presentConfine")).toBe(true);
  expect(kv.get("presentRoots")).toEqual(["/srv/out"]);
  expect(await p?.impl.get()).toMatchObject({ presentConfine: true, presentRoots: ["/srv/out"] });

  await p?.impl.set(base);
  expect(kv.get("presentConfine")).toBe(true);
  expect(() => p?.impl.set({ ...base, presentConfine: "yes" })).toThrow("presentConfine");
  expect(() => p?.impl.set({ ...base, presentRoots: [1] })).toThrow("presentRoots");
});
