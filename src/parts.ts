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

/** Mirrors a stream of events onto the parts of one assistant message. The message is created lazily (first part write) so its meta can name the model that actually ran. */
export class PartStream {
  output = false;
  readonly #store: Store;
  readonly #ensure: () => Promise<string | undefined>;
  readonly #tools = new Map<string, { writer: PartWriter; data: ToolData }>();
  #current: { kind: "text" | "reasoning"; writer: PartWriter } | undefined;
  #id: Promise<string | undefined> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: Store, ensure: () => Promise<string | undefined>) {
    this.#store = store;
    this.#ensure = ensure;
  }

  /** Drains pending writes, creates the message if nothing was ever written, returns its id (undefined if creation was refused). */
  async finish(): Promise<string | undefined> {
    await this.#queue;
    return this.#messageId();
  }

  text(kind: "text" | "reasoning", delta: string): void {
    if (delta === "") return;
    this.output = true;
    this.#enqueue((id) => {
      if (this.#current?.kind !== kind) {
        this.#closeText("complete");
        this.#current = {
          kind,
          writer: this.#store.messages.openPart(id, { type: kind, text: "" }),
        };
      }
      this.#current.writer.append(delta);
    });
  }

  notice(level: "info" | "warn" | "error", text: string): void {
    this.#enqueue((id) => {
      this.#closeText("complete");
      this.#store.messages.openPart(id, { type: "notice", level, text }).close("complete");
    });
  }

  /** Opens one complete `file` part per file, after whatever part is current. */
  files(files: { blobId: string; name: string; mime: string }[]): void {
    if (files.length === 0) return;
    this.output = true;
    this.#enqueue((id) => {
      this.#closeText("complete");
      for (const f of files) this.#store.messages.openPart(id, { type: "file", ...f }).close("complete");
    });
  }

  start(init: {
    callId: string;
    name: string;
    title?: string;
    input?: unknown;
    status: ToolData["status"];
  }): void {
    this.output = true;
    this.#enqueue((id) => {
      this.#closeText("complete");
      const { callId, name, title, input, status } = init;
      const data: ToolData = { type: "tool-call", callId, name, title, input: input ?? null, status };
      this.#tools.set(init.callId, { writer: this.#store.messages.openPart(id, data), data });
    });
  }

  update(callId: string, patch: { status?: ToolData["status"]; title?: string; outputDelta?: string }): void {
    this.#enqueue(() => {
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
    });
  }

  end(callId: string, status: ToolData["status"], fin: Pick<ToolData, "output" | "result"> = {}): void {
    this.#enqueue(() => this.#end(callId, status, fin));
  }

  closeAll(outcome: Outcome): void {
    this.#enqueue(() => {
      this.#closeText(outcome);
      const status = outcome === "complete" ? "done" : outcome === "error" ? "error" : "cancelled";
      for (const callId of [...this.#tools.keys()]) this.#end(callId, status, {});
    });
  }

  #messageId(): Promise<string | undefined> {
    this.#id ??= this.#ensure();
    return this.#id;
  }

  #enqueue(fn: (id: string) => void): void {
    this.#queue = this.#queue
      .then(async () => {
        const id = await this.#messageId();
        if (id !== undefined) fn(id);
      })
      .catch(() => undefined);
  }

  #end(callId: string, status: ToolData["status"], fin: Pick<ToolData, "output" | "result">): void {
    const tool = this.#tools.get(callId);
    if (!tool) return;
    this.#tools.delete(callId);
    const prev = tool.data.result;
    const data: ToolData = {
      ...tool.data,
      status,
      output: fin.output ?? tool.data.output,
      result: fin.result
        ? {
            ...prev,
            ...fin.result,
            ...(prev?.meta || fin.result.meta ? { meta: { ...prev?.meta, ...fin.result.meta } } : {}),
          }
        : prev,
    };
    tool.writer.close(PART_STATUS[status], data);
  }

  #closeText(status: Outcome): void {
    this.#current?.writer.close(status);
    this.#current = undefined;
  }
}
