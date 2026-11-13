import type { ModelContent, Part } from "@valethq/sdk";

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
