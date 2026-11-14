import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Role, ToolDefinition, ToolResult } from "@valethq/sdk";
import type { AgentCtx } from "./env";
import { roleAtLeast } from "./role";
import { presentConfined, presentRoots } from "./settings";

export interface Presented {
  blobId: string;
  name: string;
  mime: string;
}

const MAX_FILES = 100;
const MAX_BYTES = 64 * 1024 * 1024;

const failure = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Appends the regular files under `dir` as [absolute path, name relative to dir's parent], sorted, stopping past the cap. Symlinks and dot-entries are skipped. */
async function walk(dir: string, prefix: string, out: [string, string][]): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length > MAX_FILES) return;
    if (e.name.startsWith(".")) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) await walk(path, `${prefix}/${e.name}`, out);
    else if (e.isFile()) out.push([path, `${prefix}/${e.name}`]);
  }
}

/** `meta.presented` of a successful tool result: the files the tool wants shown to the user. */
export function presentedOf(result: ToolResult): Presented[] {
  const list = result.meta?.presented;
  if (result.isError || !Array.isArray(list)) return [];
  return list.filter(
    (p): p is Presented =>
      typeof p?.blobId === "string" && typeof p.name === "string" && typeof p.mime === "string",
  );
}

export function presentTool(ctx: AgentCtx): ToolDefinition<{ path?: unknown; name?: unknown }> {
  const confined = presentConfined(ctx);
  const minRole: Role = confined ? "trusted" : "owner";
  return {
    name: "present",
    description:
      "Present a file or folder to the user, for example an image you made or a file they should download. " +
      `Give a path ${confined ? "inside the project workspace" : "the user may share"}. ` +
      "A folder is presented as its files (hidden files and symlinks are skipped). " +
      "Writing a file does not show it to the user; call this once it is final.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or folder, absolute or relative to the workspace." },
        name: { type: "string", description: "Display name for a single file. Defaults to its basename." },
      },
      required: ["path"],
    },
    minRole,
    async invoke(input, call) {
      if (!roleAtLeast(call.role, minRole)) return failure("present is not available to this role");
      if (typeof input.path !== "string" || input.path === "") return failure("path is required");
      const target = await realpath(resolve(call.cwd, input.path)).catch(() => undefined);
      if (!target) return failure(`not found: ${input.path}`);
      if (confined) {
        const roots = await Promise.all(
          [call.cwd, ...presentRoots(ctx)].map((r) => realpath(r).catch(() => undefined)),
        );
        if (!roots.some((r) => r !== undefined && inside(r, target)))
          return failure(`${input.path} is outside the workspace`);
      }

      const info = await stat(target);
      const files: [string, string][] = [];
      if (info.isDirectory()) await walk(target, basename(target), files);
      else if (info.isFile())
        files.push([target, typeof input.name === "string" && input.name ? input.name : basename(target)]);
      if (files.length === 0) return failure(`nothing to present at ${input.path}`);
      if (files.length > MAX_FILES) return failure(`too many files (limit ${MAX_FILES})`);
      const sizes = await Promise.all(files.map(([path]) => stat(path).then((s) => s.size)));
      if (sizes.reduce((a, b) => a + b, 0) > MAX_BYTES)
        return failure(`too large (limit ${MAX_BYTES / 1024 / 1024} MiB)`);

      const presented: Presented[] = [];
      for (const [path, name] of files) {
        const file = Bun.file(path);
        const mime = file.type.split(";")[0] || "application/octet-stream";
        const { id } = await ctx.store.blobs.put(file, { mime, name });
        presented.push({ blobId: id, name, mime });
      }
      const names = presented.map((p) => p.name).join(", ");
      return {
        content: [{ type: "text", text: `Presented ${presented.length} file(s) to the user: ${names}` }],
        meta: { presented },
      };
    },
  };
}
