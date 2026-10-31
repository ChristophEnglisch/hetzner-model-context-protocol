// Shared output schemas and mappers (01 §6.9). Mappers name every field; never `...raw`.
// The only cross-import allowed between tool files goes through this module (INV§7.9).

import { z } from "zod";
import type { HetznerAction } from "../hetzner/types.js";

export const labelsOut = z.record(z.string(), z.string()).describe("Labels (untrusted data).");

export const protectionOut = z.object({
  delete: z.boolean().describe("Delete protection."),
  rebuild: z.boolean().optional().describe("Rebuild protection (servers only)."),
});

export const actionOut = z.object({
  id: z.number().int().describe("ID of the Hetzner action."),
  command: z.string().describe("Command the action performs, e.g. start_server."),
  status: z.enum(["running", "success", "error"]).describe("Status of the action."),
  progress: z.number().int().describe("Progress in percent (0-100)."),
  started: z.string().describe("Start time (ISO 8601)."),
  finished: z.string().nullable().describe("End time (ISO 8601), or null while running."),
  error: z
    .object({
      code: z.string().describe("Hetzner error code."),
      message: z.string().describe("Hetzner error message (untrusted data)."),
    })
    .nullable()
    .describe("Error of a failed action, or null."),
  resources: z
    .array(
      z.object({
        id: z.number().int().describe("ID of the resource."),
        type: z.string().describe("Type of the resource, e.g. server."),
      }),
    )
    .describe("Resources the action affects."),
});

export function toActionOut(a: HetznerAction): z.infer<typeof actionOut> {
  return {
    id: a.id,
    command: a.command,
    status: a.status,
    progress: a.progress,
    started: a.started,
    finished: a.finished,
    error: a.error ? { code: a.error.code, message: a.error.message } : null,
    resources: a.resources.map((r) => ({ id: r.id, type: r.type })),
  };
}

export const priceOut = z.object({
  net: z.string().describe("Net price as exact decimal string."),
  gross: z.string().describe("Gross price as exact decimal string."),
  currency: z.string().describe("Currency as reported by Hetzner, e.g. EUR."),
});

export const locationRefOut = z.object({
  id: z.number().int().describe("ID of the location."),
  name: z.string().describe("Name of the location, e.g. fsn1."),
});
