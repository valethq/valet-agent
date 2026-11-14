import type { Session, Store } from "@valethq/sdk";
import { agentSettings, cloneSession } from "./fork";

/** Moves a session to another project: the SDK can't change a session's project, so this copies the chat into a new session there and deletes the original. */
// spec-gap: sessions.update can't patch projectId, so a move gets a new id and drops runs, channel bindings and child links.
export async function moveSession(
  store: Store,
  sessionId: string,
  projectId: string,
  busy: boolean,
): Promise<Session> {
  const source = store.sessions.get(sessionId);
  if (!source) throw new Error("unknown session");
  if (!store.projects.get(projectId)) throw new Error("unknown project");
  if (source.projectId === projectId) throw new Error("the session is already in that project");
  if (busy || source.status === "running") throw new Error("a turn is running; move once it finishes");
  const last = store.messages.list(sessionId, { limit: 1 }).at(-1)?.message.seq ?? 0;
  const moved = await cloneSession(
    store,
    source,
    {
      projectId,
      ...(source.title === null ? {} : { title: source.title }),
      settings: agentSettings(source.settings, { movedFrom: { sessionId, projectId: source.projectId } }),
    },
    last,
  );
  const deleted = await store.sessions.delete(sessionId).catch((error: unknown) => ({
    cancelled: true as const,
    cancelReason: error instanceof Error ? error.message : String(error),
  }));
  if ("cancelled" in deleted) {
    await store.sessions.delete(moved.id).catch(() => {});
    throw new Error(`deleting the original was refused: ${deleted.cancelReason ?? "cancelled"}`);
  }
  return moved;
}
