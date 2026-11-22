import {
  type Audience,
  type Caller,
  lowestRole,
  matchPermission,
  type Message,
  type Role,
  type Run,
  type RunSubject,
  type Store,
} from "@valethq/sdk";

export interface RunStart {
  subject: RunSubject;
  /** Passed to `runs.create`; core lowers the stored role to the subject's readers. */
  role: Role;
}
export interface Refused {
  refused: string;
}

const ROLES: readonly string[] = ["guest", "trusted", "owner"];
const isRole = (v: unknown): v is Role => typeof v === "string" && ROLES.includes(v);

function readAudience(v: unknown): Audience | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { tier, principals } = v as Record<string, unknown>;
  if (tier === undefined && principals === undefined) return undefined;
  if (tier !== undefined && !isRole(tier)) return undefined;
  if (
    principals !== undefined &&
    !(Array.isArray(principals) && principals.every((p) => typeof p === "string"))
  )
    return undefined;
  return {
    ...(tier === undefined ? {} : { tier }),
    ...(principals === undefined ? {} : { principals: [...(principals as string[])] }),
  };
}

/** Who can read a reply on the message's binding. Missing metadata is not evidence of a private channel. */
export function bindingAudience(origin: Message["origin"]): Audience | undefined {
  if (!origin) return undefined;
  const meta = origin.meta ?? {};
  if (meta.audience !== undefined) return readAudience(meta.audience) ?? { tier: "guest" };
  if (isRole(meta.audienceRole)) return { tier: meta.audienceRole };
  return meta.private === true ? undefined : { tier: "guest" };
}

/** Union of principals, lowest tier. */
export function mergeAudience(a?: Audience, b?: Audience): Audience | undefined {
  if (!a || !b) return a ?? b;
  const principals =
    a.principals || b.principals
      ? [...new Set([...(a.principals ?? []), ...(b.principals ?? [])])]
      : undefined;
  const tiers = [a.tier, b.tier].filter(isRole);
  return {
    ...(tiers.length > 0 ? { tier: lowestRole(tiers) } : {}),
    ...(principals ? { principals } : {}),
  };
}

/** Patterns covered by both sides; one side alone passes through. */
export function intersectCap(a?: readonly string[], b?: readonly string[]): string[] | undefined {
  if (!a || !b) {
    const only = a ?? b;
    return only && [...only];
  }
  const covered = (p: string, by: readonly string[]) => by.some((q) => matchPermission(q, p));
  return [...new Set([...a.filter((p) => covered(p, b)), ...b.filter((p) => covered(p, a))])];
}

const roleOf = (store: Store, principalId: string | null): Role =>
  (principalId === null ? undefined : store.principals.get(principalId)?.role) ?? "guest";

// spec-gap: a caller that is another principal than the claimed author lends nothing; the claim is vouched for by the plugin, as store.as() is.
function currentSubject(store: Store, message: Message, caller: Caller): RunSubject {
  const author = message.authorPrincipalId;
  const principalId = author !== null && store.principals.get(author) ? author : null;
  const actor = principalId !== null && caller.actor?.principalId === principalId ? caller.actor : undefined;
  const audience = mergeAudience(actor?.audience, bindingAudience(message.origin));
  return {
    principalId,
    ...(actor && caller.credentialId !== undefined ? { credentialId: caller.credentialId } : {}),
    ...(actor?.tags ? { tags: [...actor.tags] } : {}),
    ...(actor?.cap ? { cap: [...actor.cap] } : {}),
    ...(audience ? { audience } : {}),
  };
}

function originRun(store: Store, message: Message, caller: Caller, principalId: string): Run | string {
  const runId = caller.actor?.runId;
  if (runId === undefined) return "no origin run";
  const run = store.runs.get(runId);
  if (!run) return `unknown origin run ${runId}`;
  const here = store.sessions.get(message.sessionId)?.parentSessionId;
  const there = store.sessions.get(run.sessionId)?.parentSessionId;
  if (run.sessionId !== message.sessionId && here !== run.sessionId && there !== message.sessionId)
    return `origin run ${runId} belongs to an unrelated session`;
  const named = run.subject
    ? run.subject.principalId
    : store.messages.list(run.sessionId).find((e) => e.message.id === run.triggerMessageId)?.message
        .authorPrincipalId;
  return named === principalId ? run : `origin run ${runId} names another principal`;
}

/**
 * The subject and role of the run `message` starts. Derived work (a wake or a subagent prompt) is limited by its
 * origin run, which only core-stamped `caller.actor.runId` can name; without a valid origin it is refused.
 */
export function startFor(
  store: Store,
  message: Message,
  caller: Caller,
  derived: boolean,
): RunStart | Refused {
  const current = currentSubject(store, message, caller);
  const role = roleOf(store, current.principalId);
  if (!derived) return { subject: current, role };
  if (current.principalId === null) return { refused: "derived work needs a known principal" };
  const run = originRun(store, message, caller, current.principalId);
  if (typeof run === "string") return { refused: run };
  const origin = run.subject ?? undefined;
  const credentialId = origin?.credentialId ?? current.credentialId;
  const tags = origin?.tags ?? current.tags;
  const cap = intersectCap(origin?.cap, current.cap);
  const audience = mergeAudience(origin?.audience, current.audience);
  return {
    subject: {
      principalId: current.principalId,
      ...(credentialId === undefined ? {} : { credentialId }),
      ...(tags ? { tags } : {}),
      ...(cap ? { cap } : {}),
      ...(audience ? { audience } : {}),
      originRunId: run.id,
    },
    role: lowestRole([run.role, role]),
  };
}
