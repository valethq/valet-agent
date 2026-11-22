import { describe, expect, test } from "bun:test";
import type { Caller, Message, Role, Run, RunSubject, Store } from "@valethq/sdk";
import { bindingAudience, intersectCap, mergeAudience, startFor } from "../src/subject";

const ROLES: Record<string, Role> = { owner: "owner", friend: "trusted", stranger: "guest" };

function fakeStore(runs: Record<string, Partial<Run> & { sessionId: string }> = {}) {
  const sessions: Record<string, { parentSessionId: string | null }> = {
    ses: { parentSessionId: null },
    child: { parentSessionId: "ses" },
    other: { parentSessionId: null },
  };
  return {
    principals: { get: (id: string) => (ROLES[id] ? { id, role: ROLES[id] } : undefined) },
    sessions: { get: (id: string) => sessions[id] },
    runs: { get: (id: string) => runs[id] },
    messages: { list: () => [{ message: { id: "trigger", authorPrincipalId: "owner" } }] },
  } as unknown as Store;
}

const run = (over: Partial<Run> & { sessionId: string }) => ({ role: "owner" as Role, ...over });
const message = (over: Partial<Message> = {}): Message =>
  ({ id: "m", sessionId: "ses", authorPrincipalId: "owner", origin: null, meta: {}, ...over }) as Message;
const as = (principalId: string, extra: Partial<Caller> = {}, actor: object = {}): Caller => ({
  plugin: "valet-agent",
  actor: { principalId, role: ROLES[principalId] ?? "guest", ...actor },
  ...extra,
});

const subjectOf = (r: ReturnType<typeof startFor>): RunSubject => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.subject;
};

describe("subject of a run", () => {
  test("a web message has the author and no audience", () => {
    const r = startFor(fakeStore(), message(), as("owner"), false);
    expect(r).toEqual({ subject: { principalId: "owner" }, role: "owner" });
  });

  test("a shared binding without metadata has an unknown-reader guest tier", () => {
    const origin = { platform: "discord", conversationId: "c" };
    const r = startFor(fakeStore(), message({ origin }), as("owner"), false);
    expect(r).toEqual({ subject: { principalId: "owner", audience: { tier: "guest" } }, role: "owner" });
  });

  test("legacy audienceRole becomes a tier, a private binding has no audience, audience is used as is", () => {
    const origin = (meta: Record<string, unknown>) => ({ platform: "discord", conversationId: "c", meta });
    expect(bindingAudience(origin({ audienceRole: "trusted" }))).toEqual({ tier: "trusted" });
    expect(bindingAudience(origin({ private: true }))).toBeUndefined();
    const audience = { principals: ["friend"], tier: "guest" as const };
    expect(bindingAudience(origin({ audience, private: true }))).toEqual(audience);
    expect(bindingAudience(origin({ audience: { tier: "admin" } }))).toEqual({ tier: "guest" });
    expect(bindingAudience(origin({ audienceRole: "admin" }))).toEqual({ tier: "guest" });
    expect(bindingAudience(null)).toBeUndefined();
  });

  test("audiences merge by union of principals and lowest tier", () => {
    expect(
      mergeAudience({ principals: ["a"], tier: "trusted" }, { principals: ["b"], tier: "guest" }),
    ).toEqual({
      principals: ["a", "b"],
      tier: "guest",
    });
    expect(mergeAudience({ principals: ["a"] }, { tier: "trusted" })).toEqual({
      principals: ["a"],
      tier: "trusted",
    });
    expect(mergeAudience(undefined, { tier: "guest" })).toEqual({ tier: "guest" });
    expect(mergeAudience(undefined, undefined)).toBeUndefined();
  });

  test("the caller's credential, cap, tags and audience survive; the binding only narrows", () => {
    const caller = as(
      "owner",
      { credentialId: "auth:tok1" },
      { cap: ["core:*"], tags: ["ci"], audience: { principals: ["friend"] } },
    );
    const origin = { platform: "discord", conversationId: "c", meta: { audienceRole: "guest" } };
    const r = startFor(fakeStore(), message({ origin }), caller, false);
    expect(r).toEqual({
      subject: {
        principalId: "owner",
        credentialId: "auth:tok1",
        tags: ["ci"],
        cap: ["core:*"],
        audience: { principals: ["friend"], tier: "guest" },
      },
      role: "owner",
    });
  });

  test("a caller that is another principal lends the claimed author nothing", () => {
    const caller = as("friend", { credentialId: "auth:x" }, { cap: ["agent:model.read"] });
    expect(subjectOf(startFor(fakeStore(), message(), caller, false))).toEqual({ principalId: "owner" });
  });

  test("an unknown or missing author is a principal-less guest run", () => {
    for (const authorPrincipalId of [null, "ghost"]) {
      const r = startFor(fakeStore(), message({ authorPrincipalId }), as("owner"), false);
      expect(r).toEqual({ subject: { principalId: null }, role: "guest" });
    }
  });

  test("capped caps intersect: patterns both sides cover", () => {
    expect(intersectCap(["exec:*", "agent:command"], ["exec:run", "agent:*"])).toEqual([
      "agent:command",
      "exec:run",
    ]);
    expect(intersectCap(["a:x"], ["b:y"])).toEqual([]);
    expect(intersectCap(["a:x"], undefined)).toEqual(["a:x"]);
    expect(intersectCap(undefined, ["*"])).toEqual(["*"]);
    expect(intersectCap(undefined, undefined)).toBeUndefined();
  });
});

describe("derived work", () => {
  const stored: RunSubject = {
    principalId: "owner",
    credentialId: "auth:tok1",
    tags: ["ci"],
    cap: ["exec:*", "agent:*"],
    audience: { tier: "trusted" },
  };
  const origin = (id = "run_a") =>
    as("owner", { credentialId: "auth:tok1" }, { runId: id, cap: ["exec:run"] });

  test("a wake in the same session inherits the origin subject and intersects the cap", () => {
    const store = fakeStore({
      run_a: run({ id: "run_a", sessionId: "ses", subject: stored, role: "trusted" }),
    });
    const r = startFor(store, message(), origin(), true);
    expect(r).toEqual({
      subject: {
        principalId: "owner",
        credentialId: "auth:tok1",
        tags: ["ci"],
        cap: ["exec:run"],
        audience: { tier: "trusted" },
        originRunId: "run_a",
      },
      role: "trusted",
    });
  });

  test("the origin's cap applies even when the current caller has none", () => {
    const store = fakeStore({ run_a: run({ id: "run_a", sessionId: "ses", subject: stored }) });
    const caller = as("owner", {}, { runId: "run_a" });
    expect(subjectOf(startFor(store, message(), caller, true))).toMatchObject({
      credentialId: "auth:tok1",
      cap: ["exec:*", "agent:*"],
    });
  });

  test("a subagent prompt takes the parent session's run, and a completion notice a child session's run", () => {
    const store = fakeStore({
      parent: run({ id: "parent", sessionId: "ses", subject: stored }),
      kid: run({ id: "kid", sessionId: "child", subject: stored }),
    });
    const prompt = message({ sessionId: "child", meta: { agent: { parentRunId: "parent" } } });
    expect(subjectOf(startFor(store, prompt, origin("parent"), true)).originRunId).toBe("parent");
    expect(subjectOf(startFor(store, message(), origin("kid"), true)).originRunId).toBe("kid");
  });

  test("an origin run without a stored subject needs its trigger message author to match", () => {
    const store = fakeStore({ run_a: run({ id: "run_a", sessionId: "ses", triggerMessageId: "trigger" }) });
    expect(subjectOf(startFor(store, message(), origin(), true))).toMatchObject({ originRunId: "run_a" });
    const other = startFor(
      store,
      message({ authorPrincipalId: "friend" }),
      as("friend", {}, { runId: "run_a" }),
      true,
    );
    expect(other).toEqual({ refused: "origin run run_a names another principal" });
  });

  test("without a valid origin the work is refused, never rebuilt from the author", () => {
    const store = fakeStore({
      run_a: run({ id: "run_a", sessionId: "ses", subject: stored }),
      far: run({ id: "far", sessionId: "other", subject: stored }),
    });
    expect(startFor(store, message(), as("owner"), true)).toEqual({ refused: "no origin run" });
    expect(startFor(store, message(), origin("missing"), true)).toEqual({
      refused: "unknown origin run missing",
    });
    expect(startFor(store, message(), origin("far"), true)).toEqual({
      refused: "origin run far belongs to an unrelated session",
    });
    expect(startFor(store, message({ authorPrincipalId: null }), origin(), true)).toEqual({
      refused: "derived work needs a known principal",
    });
  });

  test("an origin run naming another principal is refused", () => {
    const store = fakeStore({
      run_a: run({ id: "run_a", sessionId: "ses", subject: { ...stored, principalId: "friend" } }),
    });
    expect(startFor(store, message(), origin(), true)).toEqual({
      refused: "origin run run_a names another principal",
    });
  });

  test("the run role is the lowest of the origin run's and the author's", () => {
    const store = fakeStore({
      run_a: run({ id: "run_a", sessionId: "ses", subject: stored, role: "guest" }),
    });
    expect(startFor(store, message(), origin(), true)).toMatchObject({ role: "guest" });
  });
});
