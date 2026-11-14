import type { Message, Store } from "@valethq/sdk";

/** valet-agent's own keys in `message.meta.agent`. */
export interface AgentMeta {
  /** The message this one was copied from by a fork or move. Copies never start a run. */
  copiedFrom?: string;
  /** The run whose subagent tool posted this prompt into a child session. */
  parentRunId?: string;
}

export const agentMeta = (message: Message): AgentMeta => {
  const meta = message.meta.agent;
  return typeof meta === "object" && meta !== null ? (meta as AgentMeta) : {};
};

/** Copies the messages of `fromId` up to and including `throughSeq` into `toId`, in order, so seqs (and compaction cut points) line up. */
export async function copyMessages(
  store: Store,
  fromId: string,
  toId: string,
  throughSeq: number,
): Promise<number> {
  let copied = 0;
  for (const { message, parts } of store.messages.list(fromId)) {
    if (message.seq > throughSeq) break;
    const res = await store.messages.create({
      sessionId: toId,
      role: message.role,
      ...(message.authorPrincipalId ? { authorPrincipalId: message.authorPrincipalId } : {}),
      status: message.status === "streaming" ? "interrupted" : message.status,
      meta: { ...message.meta, agent: { ...agentMeta(message), copiedFrom: message.id } },
      parts: parts.map((p) => p.data),
    });
    if ("cancelled" in res)
      throw new Error(`copy of message ${message.seq} refused: ${res.cancelReason ?? "cancelled"}`);
    copied++;
  }
  return copied;
}
