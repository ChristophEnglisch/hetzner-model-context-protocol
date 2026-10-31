// Pure label functions (01 §5.2). Rules from R§2.8; the regexes are an own implementation of the
// prose in the Hetzner docs. Hetzner validates label selectors itself; nothing here parses them
// beyond splitting at top-level commas.

import { z } from "zod";
import type { LabelTerm } from "./config.js";
import type { Labels } from "./hetzner/types.js";

const NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?"; // ≤ 63
const PREFIX = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*"; // DNS subdomain
export const LABEL_KEY = new RegExp(`^(?:(?=.{1,253}/)${PREFIX}/)?${NAME}$`);
export const LABEL_VALUE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/; // may be empty
export const RESERVED_PREFIX = "hetzner.cloud/";

export const labelKeySchema = z
  .string()
  .regex(LABEL_KEY)
  .refine((k) => !k.startsWith(RESERVED_PREFIX), {
    message: "the prefix 'hetzner.cloud/' is reserved by Hetzner",
  });
export const labelsSchema = z.record(labelKeySchema, z.string().regex(LABEL_VALUE));

/**
 * Parses "k=v,k2=v2". Returns terms and issues (prefixed with varName); never throws.
 * Exactly one "=" per term ("==" is rejected), values must not be empty; whitespace around "="
 * and "," is trimmed. `uniqueKeys` rejects a key that appears twice (AND terms of the label scope;
 * OR alternatives such as IaC markers may repeat a key).
 */
export function parseLabelTerms(
  raw: string,
  varName: string,
  uniqueKeys = false,
): { terms: LabelTerm[]; issues: string[] } {
  const terms: LabelTerm[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const term = part.trim();
    if (term === "") continue;
    const eq = term.indexOf("=");
    const key = eq < 0 ? "" : term.slice(0, eq).trim();
    const value = eq < 0 ? "" : term.slice(eq + 1).trim();
    if (eq < 0 || key === "" || value === "" || value.includes("=")) {
      issues.push(
        `${varName}: '${term}' must have the form key=value (only equality, values must not be empty)`,
      );
      continue;
    }
    if (key.startsWith(RESERVED_PREFIX)) {
      issues.push(`${varName}: the prefix 'hetzner.cloud/' is reserved by Hetzner`);
      continue;
    }
    if (!LABEL_KEY.test(key)) {
      issues.push(`${varName}: invalid label key '${key}'`);
      continue;
    }
    if (!LABEL_VALUE.test(value)) {
      issues.push(`${varName}: invalid label value '${value}'`);
      continue;
    }
    if (uniqueKeys && seen.has(key)) {
      issues.push(`${varName}: key '${key}' appears twice`);
      continue;
    }
    seen.add(key);
    terms.push({ key, value });
  }
  return { terms, issues };
}

function hasTerm(term: LabelTerm, labels: Labels): boolean {
  return Object.hasOwn(labels, term.key) && labels[term.key] === term.value;
}

/** Every term matches (AND). Empty terms → true. */
export function matchesAll(terms: readonly LabelTerm[], labels: Labels): boolean {
  return terms.every((term) => hasTerm(term, labels));
}

/** The first matching term (OR), or undefined. */
export function matchingTerm(terms: readonly LabelTerm[], labels: Labels): LabelTerm | undefined {
  return terms.find((term) => hasTerm(term, labels));
}

/** Splits a Hetzner label selector at top-level commas (commas inside "( … )" stay). Parts are trimmed; empty parts dropped. */
export function splitSelector(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** "k=v,k2=v2" */
export function formatTerms(terms: readonly LabelTerm[]): string {
  return terms.map((t) => `${t.key}=${t.value}`).join(",");
}
