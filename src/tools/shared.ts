// defineTool and the shared tool building blocks (01 §6). Every tool goes through defineTool, which
// applies the guard chain of 01 §5.1 in a fixed order: schema → target → assertMutable →
// (cost limit, AP-13) → confirmation → handler → actions → output parsing → error mapping + audit.

import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  assertMutable,
  type GuardedResource,
  hasControlChars,
  requireConfirmation,
} from "../guards.js";
import { mapHetznerError, sanitizeApiText, ToolError } from "../hetzner/errors.js";
import {
  DEFAULT_PER_PAGE,
  type HetznerGateway,
  MAX_PER_PAGE,
  type Page,
  type WaitOptions,
} from "../hetzner/gateway.js";
import type { HetznerAction } from "../hetzner/types.js";
import { labelsSchema } from "../labels.js";
import type { Logger } from "../logging.js";
import { actionOut, toActionOut } from "./projections.js";

// --- contexts (6.1) ---------------------------------------------------------------------------

/** Everything a tool may depend on. Injected, never global. */
export interface ToolContext {
  config: Config;
  gateway: HetznerGateway;
  logger: Logger;
}

/** Per call. `signal` is ctx.mcpReq.signal of the SDK (client cancellation). */
export interface CallContext extends ToolContext {
  signal: AbortSignal;
  /** Name of the project this call runs against (1.0: config.projects[0].name). */
  project: string;
}

/** Same shape; gateway is a read-only view (non-GET requests throw). */
export type PreviewContext = CallContext;

// --- spec (6.2) -------------------------------------------------------------------------------

/**
 * read:        no side effects (readOnlyHint)
 * write:       changes state additively (create/update); may set costs: true
 * destructive: can lose data or remove a safety net; requires confirm: true
 */
export type ToolKind = "read" | "write" | "destructive";

/** 8.1 */
export const TOOL_NAME = /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/;

/** 7.2: never declared in any output schema, at any depth. */
export const SENSITIVE_OUTPUT_KEYS = ["root_password", "password", "wss_url", "user_data"] as const;

/** 8.4 */
const RESERVED_INPUT_KEYS = ["confirm", "wait", "project"] as const;
const RESERVED_OUTPUT_KEYS = ["warnings", "actions"] as const;

export interface Target<T> {
  /** Whatever preview and handler need (e.g. the full server object). */
  value: T;
  /** Every existing resource this call mutates (5.3). */
  resources: readonly GuardedResource[];
}

export interface ToolOutput<D> {
  /** Parsed with the output schema (unknown keys stripped) and sent as structuredContent. */
  data: D;
  /** Short, neutral summary (6.10). */
  summary: string;
  /** Required when spec.actions is true: every action the API returned (action, next_actions, actions[]). */
  actions?: readonly HetznerAction[];
}

export interface ToolSpec<I extends z.ZodObject, O extends z.ZodObject, T = undefined> {
  /** `<domain>_<verb>`; regex TOOL_NAME (8.1). */
  name: string;
  title: string;
  /** What the tool does, what it does NOT return, and its cost/risk if any. */
  description: string;
  kind: ToolKind;
  /** Default: kind !== "write". */
  idempotent?: boolean;
  /** Every field with .describe(). Must not declare: confirm, wait, project. */
  input: I;
  /** Must not declare: warnings, actions, or a sensitive key (7.2). */
  output: O;
  /** Tool creates new resources (gets withScopeLabels in its handler). */
  creates?: boolean;
  /**
   * The call can start or raise recurring costs (03 §1.1). On a write tool it adds `confirm` and requires
   * `preview`, exactly like a destructive tool, but annotations stay destructiveHint: false (6.3).
   * On a destructive tool (confirms anyway) it only marks the tool for HETZNER_MCP_ALLOW_COSTS (8.2)
   * and the cost limit (5.9) (05 K-28). `monthlyCost` and the cost limit step follow in AP-13.
   */
  costs?: boolean;
  /**
   * Loads every existing resource the call mutates. Required for write/destructive unless creates.
   * Cross-field input rules are its first statement (05 K-08): throw ToolError("bad_request") before any request.
   */
  target?: (args: z.infer<I>, ctx: CallContext) => Promise<Target<T>>;
  /** Tool triggers Hetzner actions: adds input `wait` and output `actions`. */
  actions?: boolean;
  /** Required for destructive and costs tools. One or two sentences; may read through ctx.gateway (GET only). */
  preview?: (args: z.infer<I>, ctx: PreviewContext, target: T) => string | Promise<string>;
  handler: (args: z.infer<I>, ctx: CallContext, target: T) => Promise<ToolOutput<z.infer<O>>>;
}

/** kind === "destructive" || costs === true */
export function needsConfirmation(spec: { kind: ToolKind; costs?: boolean | undefined }): boolean {
  return spec.kind === "destructive" || spec.costs === true;
}

/** What the toolset registry needs to know; produced by defineTool(). */
export interface ToolDefinition {
  readonly name: string;
  readonly kind: ToolKind;
  /** needsConfirmation(spec); tools-list tests use it for T-L4. */
  readonly confirms: boolean;
  /** spec.costs === true; selectTools drops these tools when allowCosts is false (8.2, T-R6). */
  readonly costs: boolean;
  readonly actions: boolean;
  register(server: McpServer, ctx: ToolContext): void;
}

// --- shared input fields (6.4) ----------------------------------------------------------------

export const idField = (what: string) =>
  z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe(`ID of the ${what}.`);

export const nameOrIdField = (what: string) =>
  z
    .string()
    .min(1)
    .max(255)
    .refine((v) => !hasControlChars(v), "must not contain control characters")
    .describe(`Name or ID of the ${what}.`);

/** Exported for prompts (03 §5.4, 05 K-17); single source of the hostname rule. */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export const hostnameField = z
  .string()
  .regex(HOSTNAME_RE)
  .describe(
    "Server name: unique in the project and a valid hostname (RFC 1123: letters, digits, '-' and '.').",
  );

/** The 255 limit is our own cap (not documented by Hetzner); firewalls use max 128 (SPEC). */
export const nameField = (what: string, max = 255) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !hasControlChars(v), "must not contain control characters")
    .describe(`Name of the ${what}.`);

export const labelsField = labelsSchema.describe(
  "Labels as key/value pairs. Replaces the complete label set of the resource.",
);

/** For create tools (05 K-18): there is no existing label set to replace. */
export const newLabelsField = labelsSchema.describe(
  "Labels for the new resource as key/value pairs. Label-scope labels are added automatically; a different value for a scope key is rejected.",
);

/** Selector syntax is validated by Hetzner (invalid_input), not by us. */
export const labelSelectorField = z
  .string()
  .min(1)
  .max(1000)
  .refine((v) => !hasControlChars(v), "must not contain control characters")
  .describe("Hetzner label selector, e.g. 'env=prod,!temporary' or 'env in (staging,test)'.");

export const paginationShape = {
  page: z.number().int().min(1).default(1).describe("Page number, starting at 1 (default 1)."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .default(DEFAULT_PER_PAGE)
    .describe(`Entries per page (default ${DEFAULT_PER_PAGE}, at most ${MAX_PER_PAGE}).`),
};

export const sortField = <S extends readonly [string, ...string[]]>(fields: S) =>
  z
    .enum(fields.flatMap((f) => [f, `${f}:asc`, `${f}:desc`]) as [string, ...string[]])
    .optional()
    .describe(`Sort order: field, field:asc or field:desc (fields: ${fields.join(", ")}).`);

/** Added automatically to tools with needsConfirmation(spec) (destructive or costs). */
export const confirmField = z
  .boolean()
  .optional()
  .describe(
    "Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview.",
  );

/** Added automatically to tools with actions: true. */
export const waitField = z
  .boolean()
  .default(true)
  .describe(
    "Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up.",
  );

// --- pagination (6.5) -------------------------------------------------------------------------

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().describe("Page number of this result."),
    per_page: z.number().int().describe("Page size used."),
    next_page: z
      .number()
      .int()
      .nullable()
      .describe("Next page number, or null if this is the last page."),
    total_entries: z
      .number()
      .int()
      .nullable()
      .describe("Total number of entries, or null if Hetzner did not report it."),
  });
}

/** Maps a gateway Page<Raw> through a projection. */
export function toPage<R, P>(page: Page<R>, project: (raw: R) => P) {
  return {
    items: page.items.map(project),
    page: page.page,
    per_page: page.per_page,
    next_page: page.next_page,
    total_entries: page.total_entries,
  };
}

// --- safe summary (6.10) ----------------------------------------------------------------------

const MAX_QUOTED = 64;

/**
 * The only way a name may appear in a preview: control characters removed, at most 64 characters
 * (longer names end in "…"), quoted via JSON.stringify.
 */
export function quoteName(name: string): string {
  const clean = [...name].filter((ch) => !hasControlChars(ch));
  const cut =
    clean.length > MAX_QUOTED ? `${clean.slice(0, MAX_QUOTED - 1).join("")}…` : clean.join("");
  return JSON.stringify(cut);
}

// --- definition-time checks (6.2, 7.2) --------------------------------------------------------

function findDeclaredKeys(schema: unknown, wanted: ReadonlySet<string>, found: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) findDeclaredKeys(item, wanted, found);
    return;
  }
  if (typeof schema !== "object" || schema === null) return;
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null) {
    for (const key of Object.keys(properties)) if (wanted.has(key)) found.add(key);
  }
  for (const value of Object.values(record)) findDeclaredKeys(value, wanted, found);
}

function checkSpec(spec: ToolSpec<z.ZodObject, z.ZodObject, unknown>): void {
  const fail = (message: string): never => {
    throw new Error(`Tool ${spec.name}: ${message}`);
  };
  if (!TOOL_NAME.test(spec.name)) fail(`name must match ${TOOL_NAME}`);
  if (spec.kind === "read") {
    if (
      spec.target !== undefined ||
      spec.creates === true ||
      spec.costs === true ||
      spec.preview !== undefined ||
      spec.actions === true
    ) {
      fail("read tools must not define target/creates/costs/monthlyCost/preview/actions");
    }
  } else if (spec.target === undefined && spec.creates !== true) {
    fail("write tools must define target() or set creates: true");
  }
  if (spec.kind === "destructive" && !spec.preview) fail("destructive tools must define preview()");
  if (spec.costs === true && !spec.preview) fail("cost tools must define preview()");
  for (const key of RESERVED_INPUT_KEYS) {
    if (Object.hasOwn(spec.input.shape, key)) fail(`'${key}' is reserved and added automatically`);
  }
  for (const key of RESERVED_OUTPUT_KEYS) {
    if (Object.hasOwn(spec.output.shape, key)) fail(`output key '${key}' is reserved`);
  }
  const found = new Set<string>();
  findDeclaredKeys(
    z.toJSONSchema(spec.output, { unrepresentable: "any", io: "output" }),
    new Set(SENSITIVE_OUTPUT_KEYS),
    found,
  );
  const [sensitive] = [...found];
  if (sensitive !== undefined) fail(`output must not declare '${sensitive}'`);
}

function annotationsOf(spec: { title: string; kind: ToolKind; idempotent?: boolean | undefined }) {
  return {
    title: spec.title,
    readOnlyHint: spec.kind === "read",
    destructiveHint: spec.kind === "destructive",
    idempotentHint: spec.idempotent ?? spec.kind !== "write",
    openWorldHint: true,
  };
}

// --- preview gateway (6.1) --------------------------------------------------------------------

/** Read-only view for previews: request() rejects every method except GET. */
export function readOnlyView(gateway: HetznerGateway): HetznerGateway {
  return {
    request: async (method, apiPath, options) => {
      if (method !== "GET") throw new Error("preview must not write");
      return gateway.request(method, apiPath, options);
    },
    page: (apiPath, key, options) => gateway.page(apiPath, key, options),
    paginate: (apiPath, key, options) => gateway.paginate(apiPath, key, options),
    waitForActions: (initial, options) => gateway.waitForActions(initial, options),
    getPricing: (options) => gateway.getPricing(options),
  };
}

// --- actions, wait and progress (6.6) ---------------------------------------------------------

function progressReporter(sdk: ServerContext, logger: Logger): WaitOptions["onProgress"] {
  const token = sdk.mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  let last = -1;
  return async (actions) => {
    if (actions.length === 0) return;
    const progress = Math.floor(
      actions.reduce((s, a) => s + (a.status === "running" ? a.progress : 100), 0) / actions.length,
    );
    if (progress <= last) return; // MCP: progress must increase
    last = progress;
    const running = actions.filter((a) => a.status === "running").length;
    try {
      await sdk.mcpReq.notify({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          total: 100,
          message: `${running} of ${actions.length} action(s) running`,
        },
      });
    } catch (error) {
      logger.debug("progress_notification_failed", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  };
}

/** 4.5: "Hetzner action {id} ({command}) failed: {error.code}: {error.message}" */
function actionFailedMessage(a: HetznerAction): string {
  const code = sanitizeApiText(a.error?.code ?? "unknown", 64);
  const message = sanitizeApiText(a.error?.message ?? "", 300);
  return `Hetzner action ${a.id} (${sanitizeApiText(a.command, 64)}) failed: ${code}: ${message}`;
}

// --- audit (6.8) ------------------------------------------------------------------------------

interface AuditFields {
  tool: string;
  project: string;
  outcome: string;
  targets?: string[];
  confirmed?: boolean;
  actions?: number[];
  pending?: number;
}

/** Only path and issue code of each Zod issue; never values (6.7). */
function describeFailure(error: unknown): Record<string, unknown> {
  if (error instanceof z.ZodError) {
    return {
      error: "schema mismatch",
      issues: error.issues.map((i) => `${i.path.join(".")}: ${i.code}`),
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

/**
 * A ZodError is a programming error whose message carries values; it must not reach the
 * classification by message text and always maps to "unexpected". Client cancellation arrives as a
 * real AbortError from the gateway.
 */
function classifiable(error: unknown): unknown {
  return error instanceof z.ZodError ? undefined : error;
}

// --- defineTool (6.7) -------------------------------------------------------------------------

export function defineTool<I extends z.ZodObject, O extends z.ZodObject, T = undefined>(
  spec: ToolSpec<I, O, T>,
): ToolDefinition {
  checkSpec(spec as unknown as ToolSpec<z.ZodObject, z.ZodObject, unknown>);
  const confirms = needsConfirmation(spec); // destructive or costs (6.2, K-8)
  const withActions = spec.actions === true;

  let inputSchema: z.ZodObject = spec.input;
  if (confirms) inputSchema = inputSchema.extend({ confirm: confirmField });
  if (withActions) inputSchema = inputSchema.extend({ wait: waitField });
  let outputSchema: z.ZodObject = spec.output;
  if (spec.kind !== "read") {
    outputSchema = outputSchema.extend({
      warnings: z
        .array(z.string())
        .optional()
        .describe("Notices about this change (e.g. infrastructure-as-code markers)."),
    });
  }
  if (withActions) {
    outputSchema = outputSchema.extend({
      actions: z
        .array(actionOut)
        .describe("Hetzner actions triggered by this call, with their latest state."),
    });
  }

  return {
    name: spec.name,
    kind: spec.kind,
    confirms,
    costs: spec.costs === true,
    actions: withActions,
    register(server, base) {
      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema,
          outputSchema,
          annotations: annotationsOf(spec),
        },
        async (rawArgs, sdk): Promise<CallToolResult> => {
          const started = Date.now();
          const args = rawArgs as z.infer<I> & { confirm?: boolean; wait?: boolean };
          const project = base.config.projects[0].name;
          const ctx: CallContext = { ...base, signal: sdk.mcpReq.signal, project };
          const audit: AuditFields = { tool: spec.name, project, outcome: "ok" };
          try {
            const target = spec.target ? await spec.target(args, ctx) : undefined;
            if (target) audit.targets = target.resources.map((r) => `${r.type}:${r.id}`);
            const warnings = target ? assertMutable(ctx.config, target.resources) : [];
            // Step 4 of 5.1 (cost limit, 05 K-29) is added here by AP-13.
            if (confirms) {
              audit.confirmed = args.confirm === true;
              if (ctx.config.requireConfirmation && args.confirm !== true && spec.preview) {
                const previewCtx: PreviewContext = { ...ctx, gateway: readOnlyView(ctx.gateway) };
                const preview = await spec.preview(args, previewCtx, target?.value as T);
                requireConfirmation(ctx.config, args.confirm, preview, warnings);
              }
            }

            const out = await spec.handler(args, ctx, target?.value as T);
            let summary = out.summary;
            const data: Record<string, unknown> = { ...out.data };

            if (withActions) {
              if (!out.actions) throw new Error(`Tool ${spec.name}: actions missing`);
              const triggered = [...out.actions];
              const final =
                args.wait === false
                  ? triggered
                  : await ctx.gateway.waitForActions(triggered, {
                      timeoutMs: ctx.config.actionWaitMs,
                      signal: ctx.signal,
                      onProgress: progressReporter(sdk, ctx.logger),
                    });
              const pending = final.filter((a) => a.status === "running").length;
              audit.actions = final.map((a) => a.id);
              audit.pending = pending;
              const failed = final.find((a) => a.status === "error");
              if (failed) throw new ToolError("action_failed", actionFailedMessage(failed));
              data.actions = final.map(toActionOut);
              if (pending > 0 && args.wait !== false) {
                const seconds = Math.round(ctx.config.actionWaitMs / 1000);
                summary = `${summary} Still running after ${seconds} s; follow up with action_get.`;
              }
            }

            if (warnings.length > 0) {
              data.warnings = warnings;
              summary = `${warnings.join(" ")}\n${summary}`;
            }
            const parsed = outputSchema.parse(data); // strips unknown keys (K-5); failure = programming error
            return { content: [{ type: "text", text: summary }], structuredContent: parsed };
          } catch (error) {
            const te = mapHetznerError(classifiable(error), {
              apiUrl: ctx.config.apiUrl,
              timeoutMs: ctx.config.timeoutMs,
            });
            audit.outcome = te.kind;
            if (te.kind === "unexpected") {
              ctx.logger.error("Unexpected tool failure", {
                tool: spec.name,
                ...describeFailure(error),
              });
            }
            return { isError: true, content: [{ type: "text", text: te.message }] };
          } finally {
            ctx.logger.info("tool_call", { ...audit, durationMs: Date.now() - started });
          }
        },
      );
    },
  };
}
