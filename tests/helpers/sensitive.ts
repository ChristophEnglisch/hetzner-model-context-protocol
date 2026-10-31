import { SENSITIVE_OUTPUT_KEYS } from "../../src/tools/shared.js";
import { TEST_TOKEN } from "./fakes.js";

/** Fixtures and tests set sensitive values with this prefix, e.g. root_password: "SENSITIVE-root". */
export const SENSITIVE_MARKER = "SENSITIVE-";

const KEYS: ReadonlySet<string> = new Set(SENSITIVE_OUTPUT_KEYS);

/**
 * Deep search for forbidden keys and values (01 §7, §9.2): (a) keys of SENSITIVE_OUTPUT_KEYS at any
 * depth, (b) the test token, (c) the marker "SENSITIVE-" in any string. Returns one entry per finding
 * ("<path>: <reason>"); empty means clean.
 */
export function findSensitive(value: unknown, token: string = TEST_TOKEN): string[] {
  const findings: string[] = [];
  const walk = (v: unknown, at: string): void => {
    if (typeof v === "string") {
      if (token !== "" && v.includes(token)) findings.push(`${at}: token`);
      if (v.includes(SENSITIVE_MARKER)) findings.push(`${at}: ${SENSITIVE_MARKER} marker`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        walk(item, `${at}[${i}]`);
      });
      return;
    }
    if (typeof v === "object" && v !== null) {
      for (const [key, child] of Object.entries(v)) {
        const path = at === "" ? key : `${at}.${key}`;
        if (KEYS.has(key)) findings.push(`${path}: sensitive key`);
        walk(child, path);
      }
    }
  };
  walk(value, "");
  return findings;
}
