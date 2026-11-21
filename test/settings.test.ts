import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext, SettingsContribution, ToolDefinition } from "@valethq/sdk";
import type { Catalog } from "../src/catalog";
import type { AgentConfig } from "../src/model";
import { registerSettings } from "../src/settings";

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"));

test("the doc puts the agent under system and its Models page under inference", () => {
  expect(Object.keys(manifest.settings.sections)).toEqual(["system", "inference"]);
  expect(manifest.settings.sections.inference.subsections.map((s: { id: string }) => s.id)).toEqual([
    "models",
  ]);
  const ids = manifest.settings.sections.inference.subsections[0].items.map((s: { id: string }) => s.id);
  expect(ids).toEqual(["defaultModel", "models"]);
});

test("option sources list providers, their shown models, efforts and tool names", async () => {
  const catalog = {
    providers: async () => [
      {
        provider: "p1",
        kind: "model",
        label: "One",
        icon: "cpu",
        models: [
          { id: "a", name: "A", show: true },
          { id: "b", name: "B", show: false },
        ],
      },
    ],
    info: async ({ model }: { model: string }) => ({
      id: model,
      efforts: model === "a" ? ["low", "high"] : undefined,
    }),
  } as unknown as Catalog;
  let contribution: SettingsContribution | undefined;
  const ctx = {
    scopes: {
      define() {},
      provide: (_s: string, impl: SettingsContribution) => {
        contribution = impl;
        return { dispose() {} };
      },
      all: () => [
        { impl: { list: () => [{ name: "web_search" }] } },
        {
          impl: {
            list: () => {
              throw new Error("needs a session");
            },
          },
        },
      ],
    },
  } as unknown as PluginContext<AgentConfig>;
  registerSettings(ctx, catalog, () => [{ name: "present" } as ToolDefinition]);
  const options = contribution?.options ?? {};
  expect(await options.providers?.({})).toEqual([{ value: "p1", label: "One", icon: "cpu" }]);
  expect(await options.models?.({ provider: "p1" })).toEqual([{ value: "a", label: "A" }]);
  expect(await options.models?.({ provider: "nope" })).toEqual([]);
  expect(await options.efforts?.({ provider: "p1", model: "a" })).toEqual([
    { value: "low" },
    { value: "high" },
  ]);
  expect(await options.efforts?.({})).toEqual([]);
  expect(await options.tools?.({})).toEqual([{ value: "present" }, { value: "web_search" }]);
});
