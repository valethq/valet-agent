import type { Message, ModelContent, Part, Store } from "@valethq/sdk";

export const textOf = (parts: Part[]): string =>
  parts.flatMap((p) => (p.data.type === "text" ? [p.data.text] : [])).join("\n");

export function toContent(parts: Part[]): ModelContent[] {
  const out: ModelContent[] = [];
  for (const { data } of parts) {
    if (data.type === "text" || data.type === "custom") out.push({ type: "text", text: data.text });
    else if (data.type === "file") {
      out.push(
        data.mime.startsWith("image/")
          ? { type: "image", mime: data.mime, blobId: data.blobId }
          : { type: "text", text: `[file: ${data.name}]` },
      );
    }
  }
  return out;
}

/** 9.4: a `system` message holding a custom part whose type `wakes`. The agent runs on it like on a user message. */
export const isNotification = (store: Store, message: Message, parts: Part[]): boolean =>
  message.role === "system" &&
  parts.some((p) => p.data.type === "custom" && store.partTypes.get(p.data.kind)?.wakes === true);
