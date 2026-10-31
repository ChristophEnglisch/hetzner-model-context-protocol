// Toolset firewalls (02-tool-specs/firewalls.md): list, get, create, update, set_rules,
// apply_to_resources, remove_from_resources, delete.
// The rule diff and the lock-out warning (03 §3.6, F-03) are added by AP-16 at the marked hook points.

import { z } from "zod";
import {
  assertSelectorInScope,
  type GuardedResource,
  hasControlChars,
  keepScopeLabels,
  withScopeLabels,
} from "../guards.js";
import { ToolError } from "../hetzner/errors.js";
import { path } from "../hetzner/gateway.js";
import type { HetznerAction, Labels } from "../hetzner/types.js";
import { labelsOut } from "./projections.js";
import {
  type CallContext,
  defineTool,
  idField,
  labelSelectorField,
  labelsField,
  nameField,
  newLabelsField,
  pageOf,
  paginationShape,
  quoteName,
  sortField,
  type ToolDefinition,
  toPage,
} from "./shared.js";

// --- API types (only what projections and guards read, OE-28) ---------------------------------

export interface HetznerFirewallRule {
  direction: "in" | "out";
  protocol: "tcp" | "udp" | "icmp" | "esp" | "gre";
  port?: string | null;
  source_ips?: string[];
  destination_ips?: string[];
  description?: string | null;
}

export interface HetznerFirewallAppliedTo {
  type: "server" | "label_selector";
  server?: { id: number } | null;
  label_selector?: { selector: string } | null;
  applied_to_resources?: { type: string; server?: { id: number } | null }[];
}

export interface HetznerFirewall {
  id: number;
  name: string;
  /** Not `required` in the spec (05 R-12). */
  labels?: Labels;
  created: string;
  rules: HetznerFirewallRule[];
  applied_to: HetznerFirewallAppliedTo[];
}

// --- input blocks -----------------------------------------------------------------------------

const RULE_FIELDS = ["port", "source_ips", "destination_ips"] as const;

const firewallRuleIn = z.object({
  direction: z
    .enum(["in", "out"])
    .describe(
      "Traffic direction the rule applies to. Use source_ips for 'in' and destination_ips for 'out'.",
    ),
  protocol: z.enum(["tcp", "udp", "icmp", "esp", "gre"]).describe("Network protocol of the rule."),
  port: z
    .string()
    .optional()
    .describe("Port or port range ('80' or '1024-5000'). Only for tcp and udp."),
  source_ips: z
    .array(z.string())
    .max(100)
    .optional()
    .describe(
      "Allowed source addresses in CIDR notation (at most 100), for direction 'in'. Use 0.0.0.0/0 and ::/0 for any address.",
    ),
  destination_ips: z
    .array(z.string())
    .max(100)
    .optional()
    .describe(
      "Allowed destination addresses in CIDR notation (at most 100), for direction 'out'. Use 0.0.0.0/0 and ::/0 for any address.",
    ),
  description: z
    .string()
    .max(255)
    .nullable()
    .optional()
    .describe("Free-text description of the rule (at most 255 characters)."),
});

type RuleIn = z.infer<typeof firewallRuleIn>;

/** Cheap, documented consistency checks only (A-F4); everything else (CIDR syntax, collisions) is Hetzner's. */
function checkRules(rules: readonly RuleIn[], ctx: z.RefinementCtx): void {
  rules.forEach((rule, index) => {
    const forbidden: string[] = [];
    if (rule.direction === "in" && rule.destination_ips !== undefined)
      forbidden.push("destination_ips");
    if (rule.direction === "out" && rule.source_ips !== undefined) forbidden.push("source_ips");
    if (["icmp", "esp", "gre"].includes(rule.protocol) && rule.port !== undefined)
      forbidden.push("port");
    for (const field of RULE_FIELDS.filter((f) => forbidden.includes(f))) {
      ctx.addIssue({
        code: "custom",
        message: `rule ${index + 1}: ${field} is not allowed for this direction/protocol`,
        path: [index, field],
      });
    }
  });
}

const rulesIn = (describe: string) =>
  z.array(firewallRuleIn).max(50).superRefine(checkRules).describe(describe);

const firewallTargetsShape = {
  server_ids: z
    .array(idField("server"))
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, "server IDs must be unique")
    .optional()
    .describe("IDs of servers to include. Servers need a public network interface."),
  label_selectors: z
    .array(labelSelectorField)
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Label selectors to include; every server matching one is affected, now and in the future.",
    ),
};

// --- output schemas and mappers ---------------------------------------------------------------

const ruleOut = z.object({
  direction: z.enum(["in", "out"]).describe("Traffic direction of the rule."),
  protocol: z.enum(["tcp", "udp", "icmp", "esp", "gre"]).describe("Network protocol of the rule."),
  port: z.string().nullable().describe("Port or port range, or null (icmp, esp, gre, all ports)."),
  source_ips: z.array(z.string()).describe("Allowed source addresses (CIDR) for direction 'in'."),
  destination_ips: z
    .array(z.string())
    .describe("Allowed destination addresses (CIDR) for direction 'out'."),
  description: z.string().nullable().describe("Description of the rule (untrusted data), or null."),
});

const appliedToOut = z.object({
  type: z.enum(["server", "label_selector"]).describe("Kind of target."),
  server_id: z.number().int().nullable().describe("Server ID when type is 'server', else null."),
  label_selector: z
    .string()
    .nullable()
    .describe("Selector (untrusted data) when type is 'label_selector', else null."),
  resource_server_ids: z
    .array(z.number().int())
    .describe("IDs of the servers the firewall is applied to through this target."),
});

const firewallListItem = z.object({
  id: z.number().int().describe("ID of the firewall."),
  name: z.string().describe("Name of the firewall (untrusted data)."),
  labels: labelsOut,
  created: z.string().describe("Creation time (ISO 8601)."),
  rule_count: z.number().int().describe("Number of rules."),
  applied_to_count: z
    .number()
    .int()
    .describe("Number of targets (entries, not servers) the firewall is applied to."),
});

const firewallOut = z.object({
  id: z.number().int().describe("ID of the firewall."),
  name: z.string().describe("Name of the firewall (untrusted data)."),
  labels: labelsOut,
  created: z.string().describe("Creation time (ISO 8601)."),
  rules: z.array(ruleOut).describe("Rules of the firewall."),
  applied_to: z.array(appliedToOut).describe("Targets the firewall is applied to."),
});

function toRuleOut(r: HetznerFirewallRule): z.infer<typeof ruleOut> {
  return {
    direction: r.direction,
    protocol: r.protocol,
    port: r.port ?? null,
    source_ips: r.source_ips ?? [],
    destination_ips: r.destination_ips ?? [],
    description: r.description ?? null,
  };
}

function toAppliedToOut(a: HetznerFirewallAppliedTo): z.infer<typeof appliedToOut> {
  return {
    type: a.type,
    server_id: a.type === "server" ? (a.server?.id ?? null) : null,
    label_selector: a.type === "label_selector" ? (a.label_selector?.selector ?? null) : null,
    resource_server_ids: (a.applied_to_resources ?? []).flatMap((r) =>
      r.server ? [r.server.id] : [],
    ),
  };
}

function toFirewallListItem(raw: HetznerFirewall): z.infer<typeof firewallListItem> {
  return {
    id: raw.id,
    name: raw.name,
    labels: raw.labels ?? {},
    created: raw.created,
    rule_count: raw.rules.length,
    applied_to_count: raw.applied_to.length,
  };
}

function toFirewallOut(raw: HetznerFirewall): z.infer<typeof firewallOut> {
  return {
    id: raw.id,
    name: raw.name,
    labels: raw.labels ?? {},
    created: raw.created,
    rules: raw.rules.map(toRuleOut),
    applied_to: raw.applied_to.map(toAppliedToOut),
  };
}

/** Distinct servers a firewall is applied to, directly or through label selectors. */
function appliedServerCount(raw: HetznerFirewall): number {
  const ids = new Set<number>();
  for (const a of raw.applied_to) {
    if (a.server) ids.add(a.server.id);
    for (const r of a.applied_to_resources ?? []) if (r.server) ids.add(r.server.id);
  }
  return ids.size;
}

// --- shared helpers ---------------------------------------------------------------------------

async function loadFirewall(id: number, ctx: CallContext) {
  const raw = await ctx.gateway.request<{ firewall: HetznerFirewall }>(
    "GET",
    path`/firewalls/${id}`,
    { signal: ctx.signal },
  );
  return {
    value: raw.firewall,
    resources: [
      { type: "firewall" as const, id: raw.firewall.id, labels: raw.firewall.labels ?? {} },
    ],
  };
}

interface TargetInput {
  server_ids?: number[] | undefined;
  label_selectors?: string[] | undefined;
}

/**
 * Target loading for apply/remove (05 K-24): cross-field rule first (K-08), selector scope check,
 * then the firewall and each named server. Servers behind a selector are not loaded (O-4).
 */
async function loadFirewallWithServers(id: number, args: TargetInput, ctx: CallContext) {
  const serverIds = args.server_ids ?? [];
  const selectors = args.label_selectors ?? [];
  if (serverIds.length === 0 && selectors.length === 0) {
    throw new ToolError("bad_request", "Provide at least one of server_ids or label_selectors.");
  }
  for (const selector of selectors) assertSelectorInScope(ctx.config, selector);
  const firewall = await loadFirewall(id, ctx);
  const servers = await Promise.all(
    serverIds.map((serverId) =>
      ctx.gateway.request<{ server: { id: number; labels?: Labels } }>(
        "GET",
        path`/servers/${serverId}`,
        { signal: ctx.signal },
      ),
    ),
  );
  const resources: GuardedResource[] = [
    ...firewall.resources,
    ...servers.map((s) => ({
      type: "server" as const,
      id: s.server.id,
      labels: s.server.labels ?? {},
    })),
  ];
  return { value: firewall.value, resources };
}

const targetOutput = z.object({
  id: z.number().int().describe("ID of the firewall."),
  server_count: z.number().int().describe("Number of servers named in the call."),
  label_selector_count: z.number().int().describe("Number of label selectors named in the call."),
});

function targetBody(args: TargetInput) {
  return [
    ...(args.server_ids ?? []).map((serverId) => ({
      type: "server",
      server: { id: serverId },
    })),
    ...(args.label_selectors ?? []).map((selector) => ({
      type: "label_selector",
      label_selector: { selector },
    })),
  ];
}

// --- tools ------------------------------------------------------------------------------------

const firewallList = defineTool({
  name: "firewall_list",
  title: "List firewalls",
  description:
    "Lists firewalls of the project with their ID, name, labels, and rule and target counts. Does not return the rules themselves; use firewall_get for those. Supports filtering by name or label selector and paging.",
  kind: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => !hasControlChars(v), "must not contain control characters")
      .optional()
      .describe("Only firewalls with exactly this name."),
    label_selector: labelSelectorField.optional(),
    sort: sortField(["id", "name", "created"]),
    ...paginationShape,
  }),
  output: pageOf(firewallListItem),
  handler: async (args, ctx) => {
    const page = await ctx.gateway.page<HetznerFirewall>("/firewalls", "firewalls", {
      query: { name: args.name, label_selector: args.label_selector, sort: args.sort },
      page: args.page,
      perPage: args.per_page,
      signal: ctx.signal,
    });
    const more = page.next_page === null ? "" : "; more pages available";
    return {
      data: toPage(page, toFirewallListItem),
      summary: `Found ${page.items.length} firewall(s) on page ${page.page}${more}.`,
    };
  },
});

const firewallGet = defineTool({
  name: "firewall_get",
  title: "Get a firewall",
  description:
    "Returns one firewall with all its rules and the resources it is applied to. For label-selector targets it lists the servers the selector currently matches. Does not return the firewall's action history.",
  kind: "read",
  input: z.object({ id: idField("firewall") }),
  output: firewallOut,
  handler: async (args, ctx) => {
    const { value } = await loadFirewall(args.id, ctx);
    return {
      data: toFirewallOut(value),
      summary: `Firewall ${value.id}: ${value.rules.length} rule(s), applied to ${value.applied_to.length} target(s).`,
    };
  },
});

const firewallCreate = defineTool({
  name: "firewall_create",
  title: "Create a firewall",
  description:
    "Creates a firewall with optional rules. The firewall protects nothing until it is applied to servers with firewall_apply_to_resources. Applying is a separate step on purpose; the new firewall inherits the configured label scope.",
  kind: "write",
  creates: true,
  input: z.object({
    name: nameField("firewall", 128).describe(
      "Name of the firewall: unique in the project, 1 to 128 characters.",
    ),
    rules: rulesIn("Firewall rules (at most 50). Omit for a firewall without rules.").optional(),
    labels: newLabelsField.optional(),
  }),
  output: firewallOut,
  handler: async (args, ctx) => {
    const labels = withScopeLabels(ctx.config, args.labels);
    const raw = await ctx.gateway.request<{ firewall: HetznerFirewall }>("POST", "/firewalls", {
      body: { name: args.name, rules: args.rules ?? [], labels },
      signal: ctx.signal,
    });
    const out = toFirewallOut(raw.firewall);
    return {
      data: out,
      summary: `Created firewall ${out.id} with ${out.rules.length} rule(s). It is not applied to any server yet.`,
    };
  },
});

const firewallUpdate = defineTool({
  name: "firewall_update",
  title: "Update a firewall's name or labels",
  description:
    "Renames a firewall and/or replaces its complete label set. It does not change rules or targets; use firewall_set_rules or firewall_apply_to_resources for those. Labels you send replace all existing labels, so include the ones to keep.",
  kind: "write",
  idempotent: true,
  input: z.object({
    id: idField("firewall"),
    name: nameField("firewall", 128)
      .optional()
      .describe("New name of the firewall (unique in the project, 1 to 128 characters)."),
    labels: labelsField.optional(),
  }),
  output: firewallOut,
  target: async (args, ctx) => {
    if (args.name === undefined && args.labels === undefined) {
      throw new ToolError("bad_request", "Provide name, labels, or both.");
    }
    return loadFirewall(args.id, ctx);
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ firewall: HetznerFirewall }>(
      "PUT",
      path`/firewalls/${args.id}`,
      {
        // The labels sent are the complete set (OP-1): scope labels are re-added, nothing is merged here.
        body: {
          ...(args.name !== undefined && { name: args.name }),
          ...(args.labels !== undefined && { labels: keepScopeLabels(ctx.config, args.labels) }),
        },
        signal: ctx.signal,
      },
    );
    const sent = [args.name !== undefined && "name", args.labels !== undefined && "labels"].filter(
      (f) => f !== false,
    );
    return {
      data: toFirewallOut(raw.firewall),
      summary: `Updated firewall ${args.id}: ${sent.join(", ")}.`,
    };
  },
});

const firewallSetRules = defineTool({
  name: "firewall_set_rules",
  title: "Replace all rules of a firewall",
  description:
    "Replaces ALL rules of a firewall with the given list; existing rules are discarded, and an empty list removes every rule. The change takes effect on every server the firewall is applied to and can lock you out of them (for example by dropping SSH). Returns the triggered actions, not the new rule set.",
  kind: "destructive",
  actions: true,
  input: z.object({
    id: idField("firewall"),
    rules: rulesIn(
      "The complete new rule list (at most 50). It replaces all existing rules; [] removes all rules.",
    ),
  }),
  output: z.object({
    id: z.number().int().describe("ID of the firewall."),
    rule_count: z.number().int().describe("Number of rules sent."),
  }),
  target: async (args, ctx) => loadFirewall(args.id, ctx),
  preview: (args, _ctx, fw) => {
    const parts = [
      `replace all ${fw.rules.length} rule(s) of firewall ${quoteName(fw.name)} (ID ${fw.id}) with ${args.rules.length} rule(s); it is applied to ${appliedServerCount(fw)} server(s).`,
    ];
    // AP-16 HOOK (preview): replace the sentence above with the full text of 03 §3.6
    // (appliedServerIds, rule diff, lock-out sentences {F3}) and push further parts here.
    return parts.join(" ");
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ actions: HetznerAction[] }>(
      "POST",
      path`/firewalls/${args.id}/actions/set_rules`,
      { body: { rules: args.rules }, signal: ctx.signal },
    );
    // AP-16 HOOK (summary): append the Warning:/no-inbound-rule sentences after this base text.
    const summary = `Set ${args.rules.length} rule(s) on firewall ${args.id}.`;
    return {
      data: { id: args.id, rule_count: args.rules.length },
      summary,
      actions: raw.actions,
    };
  },
});

const firewallApply = defineTool({
  name: "firewall_apply_to_resources",
  title: "Apply a firewall to servers",
  description:
    "Adds servers and/or label selectors as targets of a firewall, extending the existing targets. The firewall's rules start to filter traffic on those servers as soon as the actions finish, which can cut off connections that the rules do not allow. A server can have at most 5 firewalls, including those applied through label selectors.",
  kind: "write",
  actions: true,
  input: z.object({ id: idField("firewall"), ...firewallTargetsShape }),
  output: targetOutput,
  target: async (args, ctx) => loadFirewallWithServers(args.id, args, ctx),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ actions: HetznerAction[] }>(
      "POST",
      path`/firewalls/${args.id}/actions/apply_to_resources`,
      { body: { apply_to: targetBody(args) }, signal: ctx.signal },
    );
    const serverCount = args.server_ids?.length ?? 0;
    const selectorCount = args.label_selectors?.length ?? 0;
    // AP-16 HOOK (summary): append the `Note:` sentence of 03 §3.6 per guarded port without an allow rule
    // (input: the target firewall rules and ctx.config.firewallGuardPorts).
    return {
      data: { id: args.id, server_count: serverCount, label_selector_count: selectorCount },
      summary: `Applying firewall ${args.id} to ${serverCount} server(s) and ${selectorCount} label selector(s).`,
      actions: raw.actions,
    };
  },
});

const firewallRemove = defineTool({
  name: "firewall_remove_from_resources",
  title: "Remove a firewall from servers",
  description:
    "Removes servers and/or label-selector targets from a firewall. Servers without any firewall are no longer filtered, which may expose services that were blocked. A server that is covered through a label selector cannot be removed directly; remove the selector target instead.",
  kind: "write",
  actions: true,
  input: z.object({ id: idField("firewall"), ...firewallTargetsShape }),
  output: targetOutput,
  target: async (args, ctx) => loadFirewallWithServers(args.id, args, ctx),
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ actions: HetznerAction[] }>(
      "POST",
      path`/firewalls/${args.id}/actions/remove_from_resources`,
      { body: { remove_from: targetBody(args) }, signal: ctx.signal },
    );
    const serverCount = args.server_ids?.length ?? 0;
    const selectorCount = args.label_selectors?.length ?? 0;
    return {
      data: { id: args.id, server_count: serverCount, label_selector_count: selectorCount },
      summary: `Removing firewall ${args.id} from ${serverCount} server(s) and ${selectorCount} label selector(s).`,
      actions: raw.actions,
    };
  },
});

const firewallDelete = defineTool({
  name: "firewall_delete",
  title: "Delete a firewall",
  description:
    "Permanently deletes a firewall and its rules. Fails while the firewall is still applied to resources; remove it from all of them first. Servers it protected are no longer filtered by it.",
  kind: "destructive",
  input: z.object({ id: idField("firewall") }),
  output: z.object({
    id: z.number().int().describe("ID of the deleted firewall."),
    deleted: z.boolean().describe("True once Hetzner confirmed the deletion."),
  }),
  target: async (args, ctx) => loadFirewall(args.id, ctx),
  preview: (_args, _ctx, fw) => {
    const applied = fw.applied_to.length;
    const fails = applied > 0 ? "; deletion will fail until it is removed from all of them" : "";
    return `permanently delete firewall ${quoteName(fw.name)} (ID ${fw.id}) with ${fw.rules.length} rule(s). It is currently applied to ${applied} target(s)${fails}.`;
  },
  handler: async (args, ctx) => {
    await ctx.gateway.request("DELETE", path`/firewalls/${args.id}`, { signal: ctx.signal });
    return { data: { id: args.id, deleted: true }, summary: `Deleted firewall ${args.id}.` };
  },
});

/** Toolset firewalls. */
export const firewallTools: readonly ToolDefinition[] = [
  firewallList,
  firewallGet,
  firewallCreate,
  firewallUpdate,
  firewallSetRules,
  firewallApply,
  firewallRemove,
  firewallDelete,
];
