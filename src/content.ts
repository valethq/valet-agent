import type { Message, ModelContent, Part } from "@valethq/sdk";

export const textOf = (parts: Part[]): string =>
  parts.flatMap((p) => (p.data.type === "text" ? [p.data.text] : [])).join("\n");

export function toContent(parts: Part[]): ModelContent[] {
  const out: ModelContent[] = [];
  for (const { data } of parts) {
    if (data.type === "text") out.push({ type: "text", text: data.text });
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

/**
 * spec-gap: the spec has no notification message kind. A plugin tells the model something by posting a
 * `system` message whose `meta.notification` is set (e.g. `{ source: "valet-exec" }`); the agent runs on it
 * like on a user message, under the role of the message's author.
 */
export const isNotification = (message: Message): boolean =>
  message.role === "system" &&
  typeof message.meta.notification === "object" &&
  message.meta.notification !== null;
