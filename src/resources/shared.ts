// Shared building blocks of the MCP resources (03 §6.1, adapted from the reference server).

import type { ReadResourceResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mapHetznerError, ToolError } from "../hetzner/errors.js";
import type { ToolContext } from "../tools/shared.js";

/** Compact JSON (no indentation) to save context. */
export function jsonContents(uri: URL, data: unknown): ReadResourceResult {
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }],
  };
}

const ID_TEXT = /^[1-9][0-9]{0,15}$/;

/** Takes a URI template variable as a positive integer ID (01 §3.2 text), else ToolError("guard"). */
export function idVariable(value: string | string[] | undefined): number {
  const single = Array.isArray(value) ? value[0] : value;
  const id = single !== undefined && ID_TEXT.test(single) ? Number(single) : Number.NaN;
  if (!Number.isSafeInteger(id)) {
    throw new ToolError("guard", "Invalid id: must be a positive integer.");
  }
  return id;
}

/**
 * Runs a resource read, maps errors with mapHetznerError (text from 01 §4) and writes one audit
 * line `resource_read` in the finally block (01 §6.8, 05 K-16): never names, labels or results.
 */
export async function guardedRead<T>(
  ctx: ToolContext,
  resource: string,
  targets: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let outcome = "ok";
  try {
    return await fn();
  } catch (error) {
    // A ZodError message carries values; it is a programming error and maps to "unexpected".
    const mapped = mapHetznerError(error instanceof z.ZodError ? undefined : error, {
      apiUrl: ctx.config.apiUrl,
      timeoutMs: ctx.config.timeoutMs,
    });
    outcome = mapped.kind;
    if (mapped.kind === "unexpected") {
      ctx.logger.error("Unexpected resource failure", {
        resource,
        error: error instanceof z.ZodError ? "schema mismatch" : mapped.message,
      });
    }
    throw mapped;
  } finally {
    ctx.logger.info("resource_read", {
      resource,
      project: ctx.config.projects[0].name,
      outcome,
      ...(targets.length > 0 && { targets: [...targets] }),
      durationMs: Date.now() - started,
    });
  }
}
