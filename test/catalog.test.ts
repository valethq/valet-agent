import { describe, expect, test } from "bun:test";
import type { ModelInfo, ModelRef } from "@valethq/sdk";
import { mergeCatalog, normalizeRef, runOptions } from "../src/catalog";
import { modelLabel } from "../src/labels";
import { parseRef } from "../src/model";

const info = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id.toUpperCase(),
  contextWindow: 1000,
  maxOutputTokens: 10,
  input: ["text"],
  reasoning: true,
  ...extra,
});

describe("mergeCatalog", () => {
  const listed = [info("a", { efforts: ["low", "high"] }), info("b"), info("c", { hidden: true })];

  test("without rows, everything but hidden models shows, and base keeps the provider's values", () => {
    const out = mergeCatalog("p", listed, []);
    expect(out.map((m) => [m.id, m.show, m.custom])).toEqual([
      ["a", true, false],
      ["b", true, false],
      ["c", false, false],
    ]);
    expect(out[0]?.base?.efforts).toEqual(["low", "high"]);
  });

  test("rows override fields and visibility; other providers' rows are ignored", () => {
    const out = mergeCatalog("p", listed, [
      { provider: "p", id: "a", name: "Alpha", efforts: ["high"], fast: true },
      { provider: "p", id: "c", show: true },
      { provider: "q", id: "b", show: false },
    ]);
    expect(out[0]).toMatchObject({ name: "Alpha", efforts: ["high"], fast: true, show: true });
    expect(out[0]?.base?.name).toBe("A");
    expect(out[1]?.show).toBe(true);
    expect(out[2]?.show).toBe(true);
  });

  test('a "*" row makes the list an allowlist', () => {
    const out = mergeCatalog("p", listed, [
      { provider: "p", id: "*", show: false },
      { provider: "p", id: "b", show: true },
    ]);
    expect(out.filter((m) => m.show).map((m) => m.id)).toEqual(["b"]);
  });

  test("custom rows are appended with defaults; rows for unlisted ids without custom are dropped", () => {
    const out = mergeCatalog("p", listed, [
      { provider: "p", id: "x", custom: true, name: "X", contextWindow: 5000, efforts: ["max"] },
      { provider: "p", id: "gone", name: "stale override" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c", "x"]);
    expect(out[3]).toMatchObject({
      name: "X",
      contextWindow: 5000,
      efforts: ["max"],
      custom: true,
      show: true,
    });
    expect(out[3]?.base).toBeUndefined();
  });
});

describe("normalizeRef", () => {
  const listed = [{ id: "claude-opus-5-5" }, { id: "swe-2" }, { id: "gpt-6-sol" }, { id: "plain-high" }];
  const ref = (model: string): ModelRef => ({ provider: "p", model });

  test("splits effort and speed words off a listed base", () => {
    expect(normalizeRef(ref("claude-opus-5-5-high"), listed)).toEqual({
      provider: "p",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(normalizeRef(ref("swe-2-medium-lightning"), listed)).toEqual({
      provider: "p",
      model: "swe-2",
      effort: "medium",
      fast: true,
    });
    expect(normalizeRef(ref("gpt-6-sol-none-priority"), listed)).toMatchObject({
      effort: "none",
      fast: true,
    });
  });

  test("listed ids, unknown bases and unknown providers stay as they are", () => {
    expect(normalizeRef(ref("plain-high"), listed)).toEqual(ref("plain-high"));
    expect(normalizeRef(ref("other-high"), listed)).toEqual(ref("other-high"));
    expect(normalizeRef(ref("claude-opus-5-5-high"), undefined)).toEqual(ref("claude-opus-5-5-high"));
  });

  test("options already on the ref win", () => {
    expect(normalizeRef({ ...ref("claude-opus-5-5-high"), effort: "low" }, listed).effort).toBe("low");
  });
});

test("runOptions drops what the model can't take", () => {
  const m = info("a", { efforts: ["low"], fast: true });
  expect(runOptions({ provider: "p", model: "a", effort: "low", fast: false }, m)).toEqual({
    effort: "low",
    fast: false,
  });
  expect(runOptions({ provider: "p", model: "a", effort: "max", fast: true }, info("a"))).toEqual({});
});

test("parseRef reads provider, model, effort and speed words", () => {
  const current = { provider: "cur", model: "m" };
  const has = (k: string) => k === "p";
  expect(parseRef("p:m2 high fast", current, has)).toEqual({
    provider: "p",
    model: "m2",
    effort: "high",
    fast: true,
  });
  expect(parseRef("x:y", current, has)).toEqual({ provider: "cur", model: "x:y" });
  expect(parseRef("m3 standard", current, has)).toEqual({ provider: "cur", model: "m3", fast: false });
  expect(parseRef("  ", current, has)).toBeUndefined();
  expect(modelLabel({ provider: "p", model: "m", effort: "high", fast: true })).toBe("p:m (high, fast)");
});
