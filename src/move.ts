import {
  type AclContext,
  type Caller,
  can,
  type Decision,
  type Session,
  sessionResource,
  type Store,
} from "@valethq/sdk";
import { agentSettings, cloneSession } from "./fork";

function childrenOf(store: Store, session: Session): Session[] {
  return store.sessions
    .list({ projectId: session.projectId })
    .filter((s) => s.parentSessionId === session.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function descendants(store: Store, session: Session): Session[] {
  return childrenOf(store, session).flatMap((child) => [child, ...descendants(store, child)]);
}

/**
 * Kept only when the parent is already in the destination project.
 * Subagents are created in the parent's project, so a child moved on its own would point at another project.
 */
function parentInDestination(store: Store, session: Session, projectId: string): string | undefined {
  const id = session.parentSessionId;
  if (id === null) return undefined;
  const parent = store.sessions.get(id);
  return parent !== undefined && parent.projectId === projectId ? parent.id : undefined;
}

async function discard(store: Store, ids: readonly string[]): Promise<void> {
  for (const id of [...ids].reverse()) await store.sessions.delete(id).catch(() => {});
}

async function cloneInto(
  store: Store,
  session: Session,
  projectId: string,
  parentSessionId: string | undefined,
): Promise<Session> {
  const last = store.messages.list(session.id, { limit: 1 }).at(-1)?.message.seq ?? 0;
  return cloneSession(
    store,
    session,
    {
      projectId,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(session.title === null ? {} : { title: session.title }),
      settings: agentSettings(session.settings, {
        movedFrom: { sessionId: session.id, projectId: session.projectId },
      }),
    },
    last,
  );
}

/**
 * The first `core:session.write` denial over the move: the source, each descendant (a session grant on the
 * parent does not cover a child) and the destination project. Both entry points check it before moving.
 */
export function moveDenied(
  ctx: AclContext,
  caller: Caller,
  store: Store,
  source: Session,
  projectId: string,
): Extract<Decision, { allow: false }> | undefined {
  for (const s of [source, ...descendants(store, source)]) {
    const d = can(ctx, caller, "core:session.write", sessionResource(ctx, s.id));
    if (!d.allow) return d;
  }
  const d = can(ctx, caller, "core:session.write", { id: `project:${projectId}` });
  return d.allow ? undefined : d;
}

/** Moves a session and its subagent children to another project. The SDK can't change a session's project, so this copies each chat into a new session there and deletes the originals. */
// spec-gap: sessions.update can't patch projectId, so a move gets a new id and drops runs and channel bindings.
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
  const tree = descendants(store, source);
  if (busy || source.status === "running" || tree.some((s) => s.status === "running"))
    throw new Error("a turn is running; move once it finishes");

  const copies: { original: string; copy: string }[] = [];
  let moved: Session;
  try {
    moved = await cloneInto(store, source, projectId, parentInDestination(store, source, projectId));
    copies.push({ original: source.id, copy: moved.id });
    const ids = new Map<string, string>([[source.id, moved.id]]);
    for (const child of tree) {
      const parentId = ids.get(child.parentSessionId ?? "");
      if (parentId === undefined) throw new Error("missing moved parent");
      const copy = await cloneInto(store, child, projectId, parentId);
      copies.push({ original: child.id, copy: copy.id });
      ids.set(child.id, copy.id);
    }
  } catch (error) {
    await discard(
      store,
      copies.map((c) => c.copy),
    );
    throw error;
  }

  const removed = new Set<string>();
  for (const session of [source, ...tree].reverse()) {
    const deleted = await store.sessions.delete(session.id).catch((error: unknown) => ({
      cancelled: true as const,
      cancelReason: error instanceof Error ? error.message : String(error),
    }));
    if ("cancelled" in deleted) {
      // Keep copies whose originals are already gone. Deleting a surviving copy clears
      // parent_session_id on children, so a kept child does not point at a removed copy.
      await discard(
        store,
        copies.filter((c) => !removed.has(c.original)).map((c) => c.copy),
      );
      const why = deleted.cancelReason ?? "cancelled";
      throw new Error(`move was partial: deleting the original was refused: ${why}`);
    }
    removed.add(session.id);
  }
  return moved;
}
