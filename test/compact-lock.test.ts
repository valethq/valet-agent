import { describe, expect, test } from "bun:test";
import type { Env } from "../src/env";
import { RunQueue } from "../src/queue";

const queue = () => new RunQueue({} as Env);

describe("beginCompact", () => {
  test("a second compaction waits for the first release", async () => {
    const q = queue();
    const release = await q.beginCompact("ses");
    let second = false;
    const waiting = q.beginCompact("ses").then(() => {
      second = true;
    });
    await Bun.sleep(5);
    expect(second).toBe(false);
    release();
    await waiting;
    expect(second).toBe(true);
  });

  test("a stale release leaves the newer lock held", async () => {
    const q = queue();
    const first = await q.beginCompact("ses");
    first();
    const second = await q.beginCompact("ses");
    first();
    let third = false;
    const waiting = q.beginCompact("ses").then(() => {
      third = true;
    });
    await Bun.sleep(5);
    expect(third).toBe(false);
    second();
    await waiting;
  });
});
