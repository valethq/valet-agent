import type { PartData, PartWriter, Store } from "@valethq/sdk";

type ToolData = Extract<PartData, { type: "tool-call" }>;
type Outcome = "complete" | "error" | "interrupted";

const PART_STATUS: Record<ToolData["status"], Outcome> = {
  pending: "interrupted",
  running: "interrupted",
  done: "complete",
  denied: "complete",
  error: "error",
  cancelled: "interrupted",
};

/** Mirrors a stream of events onto the parts of one assistant message. */
export class PartStream {
  output = false;
  readonly #store: Store;
  readonly #messageId: string;
  readonly #tools = new Map<string, { writer: PartWriter; data: ToolData }>();
  #current: { kind: "text" | "reasoning"; writer: PartWriter } | undefined;

  constructor(store: Store, messageId: string) {
    this.#store = store;
    this.#messageId = messageId;
  }

  text(kind: "text" | "reasoning", delta: string): void {
    if (delta === "") return;
    if (this.#current?.kind !== kind) {
      this.#closeText("complete");
      this.#current = {
        kind,
        writer: this.#store.messages.openPart(this.#messageId, { type: kind, text: "" }),
      };
    }
    this.#current.writer.append(delta);
    this.output = true;
  }

  start(init: {
    callId: string;
    name: string;
    title?: string;
    input?: unknown;
    status: ToolData["status"];
  }): void {
    this.#closeText("complete");
    const { callId, name, title, input, status } = init;
    const data: ToolData = { type: "tool-call", callId, name, title, input: input ?? null, status };
    this.#tools.set(init.callId, { writer: this.#store.messages.openPart(this.#messageId, data), data });
    this.output = true;
  }

  update(callId: string, patch: { status?: ToolData["status"]; title?: string; outputDelta?: string }): void {
    const tool = this.#tools.get(callId);
    if (!tool) return;
    if (patch.outputDelta) {
      tool.writer.append(patch.outputDelta);
      tool.data = { ...tool.data, output: (tool.data.output ?? "") + patch.outputDelta };
    }
    if (patch.status || patch.title) {
      tool.data = {
        ...tool.data,
        ...(patch.status && { status: patch.status }),
        ...(patch.title && { title: patch.title }),
      };
      tool.writer.replace(tool.data);
    }
  }

  end(callId: string, status: ToolData["status"], fin: Pick<ToolData, "output" | "result"> = {}): void {
    const tool = this.#tools.get(callId);
    if (!tool) return;
    this.#tools.delete(callId);
    const data: ToolData = {
      ...tool.data,
      status,
      output: fin.output ?? tool.data.output,
      result: fin.result,
    };
    tool.writer.close(PART_STATUS[status], data);
  }

  closeAll(outcome: Outcome): void {
    this.#closeText(outcome);
    const status = outcome === "complete" ? "done" : outcome === "error" ? "error" : "cancelled";
    for (const callId of [...this.#tools.keys()]) this.end(callId, status);
  }

  #closeText(status: Outcome): void {
    this.#current?.writer.close(status);
    this.#current = undefined;
  }
}
