import type { Caller, Role, Store } from "@valethq/sdk";

export function authorRole(store: Store, authorId: string | null, caller: Caller): Role {
  const principal = authorId ? store.principals.get(authorId) : undefined;
  return principal?.role ?? (caller.actor?.role === "owner" ? "owner" : "guest");
}
