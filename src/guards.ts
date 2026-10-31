// Guards (01 §5). Pure functions, no I/O; defineTool (tools/shared.ts) calls them in the order of
// 01 §5.1. Protection is deliberately not a guard: Hetzner refuses protected operations itself.

import type { Config } from "./config.js";
import { isControlChar, ToolError } from "./hetzner/errors.js";
import type { Labels } from "./hetzner/types.js";
import { formatTerms, matchesAll, matchingTerm, splitSelector } from "./labels.js";

export type ResourceType = "server" | "ssh_key" | "firewall" | "volume" | "image";

export interface GuardedResource {
  readonly type: ResourceType;
  readonly id: number;
  readonly labels: Labels;
}

/** Control characters as defined by isControlChar (OE-24), including C1, line separators and bidi controls. */
export function hasControlChars(value: string): boolean {
  for (const char of value) if (isControlChar(char)) return true;
  return false;
}

/**
 * Validates a value that ends up as a URL path segment (01 §5.7; from the reference).
 * Rejects separators, dot segments and control characters.
 */
export function assertPathSegment(value: string, label = "value"): void {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    hasControlChars(value)
  ) {
    throw new ToolError(
      "guard",
      `Invalid ${label}: must be non-empty and must not contain '/', '\\', '..' or control characters.`,
    );
  }
}

/** English display names for `{Type}` in guard texts (OE-23); `{type}` stays the raw value. */
const DISPLAY_NAMES: Readonly<Record<ResourceType, string>> = {
  server: "Server",
  ssh_key: "SSH key",
  firewall: "Firewall",
  volume: "Volume",
  image: "Image",
};

/**
 * Throws ToolError("guard") if a resource is outside the label scope or (iacPolicy "block") carries an IaC marker.
 * Returns warning texts for iacPolicy "warn". Pure; no I/O.
 */
export function assertMutable(
  config: Pick<Config, "labelScope" | "iacPolicy" | "iacMarkers">,
  resources: readonly GuardedResource[],
): string[] {
  // The scope is the hard boundary: every resource is checked against it before any IaC marker.
  for (const r of resources) {
    if (!matchesAll(config.labelScope, r.labels)) {
      throw new ToolError(
        "guard",
        `Resource ${r.type} ${r.id} is outside the label scope (HETZNER_MCP_LABEL_SCOPE=${formatTerms(config.labelScope)}). Only resources carrying these labels may be changed. Nothing was changed.`,
      );
    }
  }
  const warnings: string[] = [];
  if (config.iacPolicy === "off") return warnings;
  for (const r of resources) {
    const marker = matchingTerm(config.iacMarkers, r.labels);
    if (!marker) continue;
    if (config.iacPolicy === "block") {
      throw new ToolError(
        "guard",
        `${DISPLAY_NAMES[r.type]} ${r.id} carries the infrastructure-as-code marker '${marker.key}=${marker.value}'. Changes are blocked (HETZNER_MCP_IAC_POLICY=block); change it in the infrastructure code instead. Nothing was changed.`,
      );
    }
    warnings.push(
      `Warning: ${r.type} ${r.id} carries the infrastructure-as-code marker '${marker.key}=${marker.value}'; the next terraform/tofu apply may revert or conflict with this change.`,
    );
  }
  return warnings;
}

function enforceScope(config: Pick<Config, "labelScope">, labels: Labels | undefined): Labels {
  const result: Record<string, string> = { ...labels };
  for (const term of config.labelScope) {
    if (Object.hasOwn(result, term.key) && result[term.key] !== term.value) {
      throw new ToolError(
        "guard",
        `Label '${term.key}' is reserved by HETZNER_MCP_LABEL_SCOPE and must be '${term.value}'. Remove it from the labels or use that value.`,
      );
    }
    result[term.key] = term.value;
  }
  return result;
}

/**
 * Labels for a new resource: user labels + scope labels.
 * Throws ToolError("guard") if the user sets a scope key to a different value.
 */
export function withScopeLabels(config: Pick<Config, "labelScope">, labels?: Labels): Labels {
  return enforceScope(config, labels);
}

/**
 * Label updates on existing resources (PUT replaces the whole set, see OP-1):
 * returns `labels` with the scope labels enforced. A missing scope key is re-added silently
 * (the scope is a system property, 01 §5.3); a scope key with a different value throws.
 */
export function keepScopeLabels(config: Pick<Config, "labelScope">, labels: Labels): Labels {
  return enforceScope(config, labels);
}

/** One top-level selector part as equality term ("k=v" or "k==v"), else undefined. */
function equalityTerm(part: string): { key: string; value: string } | undefined {
  const m = /^([^=!\s()]+)\s*==?\s*([^=\s()]*)$/.exec(part.trim());
  if (!m) return undefined;
  return { key: m[1] ?? "", value: m[2] ?? "" };
}

/**
 * Label selector targets (firewall apply_to) in scope mode must contain every scope term
 * as a top-level term ("k=v" or "k==v"). Otherwise the selector could reach resources outside the scope.
 */
export function assertSelectorInScope(config: Pick<Config, "labelScope">, selector: string): void {
  if (config.labelScope.length === 0) return;
  const terms = splitSelector(selector)
    .map(equalityTerm)
    .filter((t) => t !== undefined);
  const covered = config.labelScope.every((scope) =>
    terms.some((t) => t.key === scope.key && t.value === scope.value),
  );
  if (!covered) {
    throw new ToolError(
      "guard",
      `In label-scope mode a label selector must contain every scope term (${formatTerms(config.labelScope)}) as its own term, so it cannot reach resources outside the scope.`,
    );
  }
}

/**
 * Tools that need confirmation must be called with confirm=true when confirmation is required.
 * Throws ToolError("confirmation_required") carrying preview and warnings so the model can ask the user and retry.
 */
export function requireConfirmation(
  policy: Pick<Config, "requireConfirmation">,
  confirm: boolean | undefined,
  preview: string,
  warnings: readonly string[] = [],
): void {
  if (!policy.requireConfirmation || confirm === true) return;
  const what = [preview, ...warnings].join(" ");
  throw new ToolError(
    "confirmation_required",
    `Confirmation required. This would: ${what} Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.`,
  );
}
