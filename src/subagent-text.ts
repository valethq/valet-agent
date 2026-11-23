import type { Session, Store } from "@valethq/sdk";
import type { Presented } from "./present";

export interface Task {
  index: number;
  prompt: string;
  stage: number;
  title?: string;
  session?: string;
  model?: string;
}

export interface Outcome {
  task: Task;
  session?: Session;
  status: string;
  error?: string;
  reply: string;
  presented: Presented[];
  /** The child run that answered, when one ran. */
  runId?: string;
}

export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export const titleOf = (o: Pick<Outcome, "task" | "session">): string =>
  o.task.title ?? o.session?.title ?? oneLine(o.task.prompt).slice(0, 60);

export function replyOf(store: Store, sessionId: string, runId: string | undefined) {
  const run = runId ? store.runs.get(runId) : undefined;
  const parts = store.messages
    .list(sessionId, { limit: 50 })
    .filter(({ message }) => runId !== undefined && message.role === "assistant" && message.runId === runId)
    .flatMap((e) => e.parts);
  const reply = parts
    .flatMap(({ data }) => (data.type === "text" ? [data.text] : []))
    .join("\n")
    .trim();
  const presented: Presented[] = parts.flatMap(({ data }) =>
    data.type === "file" ? [{ blobId: data.blobId, name: data.name, mime: data.mime }] : [],
  );
  return {
    ...(runId ? { runId } : {}),
    reply,
    presented,
    status: run?.status ?? "never ran",
    ...(run?.error ? { error: run.error } : {}),
  };
}

export const footer = (id: string): string =>
  `[subagent session ${id}; pass it as "session" to continue this subagent]`;

/** `maxReply` cuts each reply that is longer (the notification); the result of a call that waited keeps them whole. */
export function outcomeText(outcomes: Outcome[], maxReply?: number): string {
  return outcomes
    .map((o) => {
      const title = titleOf(o);
      const head = outcomes.length > 1 ? `### ${title}\n` : "";
      const note =
        o.status === "complete" ? "" : `The subagent run ${o.status}${o.error ? `: ${o.error}` : ""}.\n`;
      const cut = maxReply !== undefined && o.reply.length > maxReply;
      const reply = cut
        ? `${o.reply.slice(0, maxReply)}…\n(reply cut at ${maxReply} characters; session_view with the session id has the rest)`
        : o.reply;
      const body = reply || (o.status === "complete" ? "(no reply)" : "");
      const files =
        maxReply !== undefined && o.presented.length > 0
          ? `(the subagent presented ${o.presented.length} file${o.presented.length === 1 ? "" : "s"}; they are in its session)`
          : "";
      return [`${head}${note}${body}`.trim(), files, o.session ? footer(o.session.id) : ""]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
}
