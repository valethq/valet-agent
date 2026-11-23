import type { Caller, Role } from "@valethq/sdk";

const DEFAULTS: Record<string, Role> = {
  "agent:present": "trusted",
  "agent:subagent": "owner",
  "agent:command": "owner",
  "agent:model.read": "owner",
  "core:session.write": "owner",
  "core:session.read": "owner",
};

export const principalOf = (role: Role): string => `p-${role}`;

export const callerOf = (role: Role): Caller => ({
  plugin: "valet-agent",
  actor: { principalId: principalOf(role), role },
});

/** What `can` and `defineTool` read from a PluginContext: declared permissions, and one principal per role. */
export const aclParts = {
  acl: {
    permission: (name: string) => (name in DEFAULTS ? { summary: name, default: DEFAULTS[name] } : undefined),
    credential: () => undefined,
  },
  scopes: { maybe: () => undefined },
  log: { warn: () => {}, error: () => {} },
  plugin: { id: "valet-agent" },
};

export const principals = {
  get: (id: string) => (id.startsWith("p-") ? { id, role: id.slice(2) as Role } : undefined),
};

/** Every permission is declared and held by guests, so tests of other behaviour pass the check. */
export const openAcl = {
  ...aclParts,
  acl: {
    permission: (name: string) => ({ summary: name, default: "guest" as Role }),
    credential: () => undefined,
  },
};
