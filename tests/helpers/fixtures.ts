import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge; arrays and scalars in `patch` replace, objects are merged recursively. */
function merge(base: unknown, patch: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] = k in base ? merge(base[k], v) : structuredClone(v);
    }
    return out;
  }
  return structuredClone(patch);
}

/**
 * Loads tests/fixtures/<operationId>.json (generated from the OpenAPI spec, 01 §9.4) as a deep
 * clone without the `$source` header. `overrides` is deep-merged; arrays in overrides replace.
 */
export function fixture<T = unknown>(operationId: string, overrides?: DeepPartial<T>): T {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, `${operationId}.json`), "utf8")) as Record<
    string,
    unknown
  >;
  delete raw.$source;
  return (overrides === undefined ? raw : merge(raw, overrides)) as T;
}
