import type { ModelRef } from "@valethq/sdk";

/** "claude-code:claude-opus-5-5 (high, fast)" for command replies. */
export function modelLabel(ref: ModelRef): string {
  const opts = [
    ref.effort,
    ref.fast === true ? "fast" : ref.fast === false ? "standard speed" : undefined,
  ].filter((o): o is string => o !== undefined);
  return `${ref.provider}:${ref.model}${opts.length > 0 ? ` (${opts.join(", ")})` : ""}`;
}
