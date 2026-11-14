import type { Session, SessionSettings, Store } from "@valethq/sdk";
import { copyMessages } from "./copy";

const isCancelled = (r: object): r is { cancelled: true; cancelReason?: string } => "cancelled" in r;

/** `settings` with `patch` merged into its `agent` namespace; the title placeholder and the link to the run that spawned a subagent are dropped (a copy is not that run's child). */
export function agentSettings(settings: SessionSettings, patch: Record<string, unknown>): SessionSettings {
  const { titlePlaceholder: _, ...rest } = structuredClone(settings);
  const {
    parentRunId: _r,
    stage: _s,
    ...agent
  } = (typeof rest.agent === "object" && rest.agent !== null ? rest.agent : {}) as Record<string, unknown>;
  return { ...rest, agent: { ...agent, ...patch } };
}

/** Creates `init`, copies `source`'s messages through `throughSeq` into it, and deletes it again if the copy fails. */
export async function cloneSession(
  store: Store,
  source: Session,
  init: Parameters<Store["sessions"]["create"]>[0],
  throughSeq: number,
): Promise<Session> {
  const created = await store.sessions.create(init);
  if (isCancelled(created)) throw new Error(`session create refused: ${created.cancelReason ?? "cancelled"}`);
  try {
    if (source.color !== null) await store.sessions.update(created.id, { color: source.color });
    await copyMessages(store, source.id, created.id, throughSeq);
  } catch (error) {
    await store.sessions.delete(created.id).catch(() => {});
    throw error;
  }
  return store.sessions.get(created.id) ?? created;
}

/** A new session in the same project holding the chat up to and including `messageId` (default: the latest message). */
export async function forkSession(store: Store, sessionId: string, messageId?: string): Promise<Session> {
  const source = store.sessions.get(sessionId);
  if (!source) throw new Error("unknown session");
  const entries = store.messages.list(sessionId);
  const at = messageId === undefined ? entries.at(-1) : entries.find((e) => e.message.id === messageId);
  if (!at) throw new Error(messageId === undefined ? "the session has no messages" : "unknown message");
  // spec-gap: AgentProvider has no fork, so a harness-backed fork opens a fresh remote session seeded with the copied history.
  return cloneSession(
    store,
    source,
    {
      projectId: source.projectId,
      ...(source.title === null ? {} : { title: `${source.title} (fork)` }),
      settings: agentSettings(source.settings, { forkedFrom: { sessionId, messageId: at.message.id } }),
      ...(source.parentSessionId === null ? {} : { parentSessionId: source.parentSessionId }),
    },
    at.message.seq,
  );
}
