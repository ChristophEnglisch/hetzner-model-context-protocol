import { z } from "zod";
import { formatTerms, parseLabelTerms } from "./labels.js";
import { LOG_LEVELS, type LogLevel } from "./logging.js";

export const TOOLSET_NAMES = [
  "core",
  "info",
  "actions",
  "ssh_keys",
  "firewalls",
  "storage",
] as const;
export type ToolsetName = (typeof TOOLSET_NAMES)[number];

export const DEFAULT_TOOLSETS: readonly ToolsetName[] = ["core", "info", "actions", "ssh_keys"];

export const IAC_POLICIES = ["off", "warn", "block"] as const;
export type IacPolicy = (typeof IAC_POLICIES)[number];

/** One `key=value` equality term. */
export interface LabelTerm {
  readonly key: string;
  readonly value: string;
}

/** F-05: 1.0 has exactly one project; 1.1 widens the tuple to a non-empty array. */
export interface ProjectConfig {
  readonly name: string; // HETZNER_MCP_PROJECT_NAME
  readonly token: string;
}

export interface Config {
  /** Without trailing slash. */
  apiUrl: string;
  projects: readonly [ProjectConfig];
  tokenSource: "HETZNER_TOKEN" | "HCLOUD_TOKEN";
  readOnly: boolean;
  toolsets: ReadonlySet<ToolsetName>;
  /** AND terms. Empty = no write scope. */
  labelScope: readonly LabelTerm[];
  iacPolicy: IacPolicy;
  /** OR alternatives. */
  iacMarkers: readonly LabelTerm[];
  requireConfirmation: boolean;
  timeoutMs: number;
  actionWaitMs: number;
  /** TCP ports guarded by the firewall lockout warning; sorted, unique; default [22]. */
  firewallGuardPorts: readonly number[];
  /** false = tools with costs: true are not registered. Default true. */
  allowCosts: boolean;
  /**
   * HETZNER_MCP_MAX_MONTHLY_COST as validated decimal string (net, pricing currency), or undefined.
   * Kept as string: config.ts must not depend on hetzner/pricing.ts.
   */
  maxMonthlyCost: string | undefined;
  logLevel: LogLevel;
  /** Non-fatal notices for the caller to log. */
  warnings: readonly string[];
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const DEFAULT_API_URL = "https://api.hetzner.cloud/v1";
const DEFAULT_IAC_LABELS = "managed-by=terraform,managed_by=terraform";
const hasBadTokenChars = (value: string): boolean =>
  /\s/.test(value) || [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
const MAX_MONTHLY_COST = /^\d{1,15}(?:\.\d{1,20})?$/;
const blankToUndefined = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const flag = (fallback: boolean) =>
  z.preprocess(
    blankToUndefined,
    z.stringbool({ error: "must be true or false" }).default(fallback),
  );

const EnvSchema = z.object({
  HETZNER_MCP_READ_ONLY: flag(false),
  HETZNER_MCP_REQUIRE_CONFIRMATION: flag(true),
  HETZNER_MCP_ALLOW_COSTS: flag(true),
  HETZNER_MCP_IAC_POLICY: z.preprocess(
    blankToUndefined,
    z.enum(IAC_POLICIES, { error: `must be one of: ${IAC_POLICIES.join(", ")}` }).default("warn"),
  ),
  HETZNER_MCP_LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(LOG_LEVELS, { error: `must be one of: ${LOG_LEVELS.join(", ")}` }).default("info"),
  ),
});

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  message: string,
  issues: string[],
): number {
  if (raw === undefined) return fallback;
  const value = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push(message);
    return fallback;
  }
  return value;
}

function parseToolsets(raw: string | undefined, issues: string[]): Set<ToolsetName> {
  const names =
    raw === undefined
      ? []
      : raw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
  if (names.length === 0) return new Set(DEFAULT_TOOLSETS);
  const result = new Set<ToolsetName>();
  for (const name of names) {
    if (name === "all") continue;
    if ((TOOLSET_NAMES as readonly string[]).includes(name)) {
      result.add(name as ToolsetName);
    } else {
      issues.push(
        `HETZNER_MCP_TOOLSETS: unknown toolset '${name}' (valid: ${TOOLSET_NAMES.join(", ")}, all)`,
      );
    }
  }
  return names.includes("all") ? new Set(TOOLSET_NAMES) : result;
}

function parseGuardPorts(raw: string | undefined, issues: string[]): number[] {
  if (raw === undefined) return [22];
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) return [22];
  const valid =
    items.length <= 10 &&
    items.every((item) => {
      if (!/^\d{1,5}$/.test(item)) return false;
      const port = Number(item);
      return port >= 1 && port <= 65535;
    });
  if (!valid) {
    issues.push(
      `HETZNER_MCP_FIREWALL_GUARD_PORTS: '${raw}' must be a list of TCP ports between 1 and 65535 (comma-separated, at most 10)`,
    );
    return [22];
  }
  return [...new Set(items.map(Number))].sort((a, b) => a - b);
}

/**
 * Parses and validates the environment. There are deliberately no credential
 * defaults: missing or contradictory settings fail fast with a ConfigError that
 * lists every problem. No network access happens here.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issues: string[] = [];
  const warnings: string[] = [];
  const raw = (name: string): string | undefined =>
    blankToUndefined(env[name]) as string | undefined;

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join(".") || "env"}: ${issue.message}`);
    }
  }

  // Token
  const primary = raw("HETZNER_TOKEN");
  const alias = raw("HCLOUD_TOKEN");
  let token: string | undefined;
  let tokenSource: Config["tokenSource"] = "HETZNER_TOKEN";
  if (primary === undefined && alias === undefined) {
    issues.push(
      "HETZNER_TOKEN: is required (API token of the Hetzner Cloud project; HCLOUD_TOKEN is accepted as an alias)",
    );
  } else {
    if (primary !== undefined && hasBadTokenChars(primary)) {
      issues.push("HETZNER_TOKEN: must not contain whitespace or control characters");
    }
    if (alias !== undefined && hasBadTokenChars(alias)) {
      issues.push("HCLOUD_TOKEN: must not contain whitespace or control characters");
    }
    if (primary !== undefined && alias !== undefined && primary !== alias) {
      issues.push(
        "HETZNER_TOKEN and HCLOUD_TOKEN are both set to different values; set only one (each token belongs to exactly one project)",
      );
    }
    token = primary ?? alias;
    tokenSource = primary !== undefined ? "HETZNER_TOKEN" : "HCLOUD_TOKEN";
  }

  // API URL
  const rawUrl = raw("HETZNER_API_URL") ?? DEFAULT_API_URL;
  const urlMessage = "HETZNER_API_URL: must be an https URL (http is only allowed for localhost)";
  let apiUrl = DEFAULT_API_URL;
  let apiHost = "api.hetzner.cloud";
  if (!z.url().safeParse(rawUrl).success) {
    issues.push(urlMessage);
  } else {
    const url = new URL(rawUrl);
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      issues.push(
        "HETZNER_API_URL: must not contain credentials, a query or a fragment (the token is sent as a header)",
      );
    } else if (
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackHost(url.hostname))
    ) {
      apiUrl = rawUrl.replace(/\/+$/, "");
      apiHost = url.hostname;
    } else {
      issues.push(urlMessage);
    }
  }

  // Project name
  const projectName = raw("HETZNER_MCP_PROJECT_NAME") ?? "default";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(projectName)) {
    issues.push(
      "HETZNER_MCP_PROJECT_NAME: must start with a letter and contain only a-z, 0-9 and '-' (max 32)",
    );
  }

  const toolsets = parseToolsets(raw("HETZNER_MCP_TOOLSETS"), issues);

  const scopeRaw = raw("HETZNER_MCP_LABEL_SCOPE");
  const scope =
    scopeRaw === undefined
      ? { terms: [] as LabelTerm[], issues: [] as string[] }
      : parseLabelTerms(scopeRaw, "HETZNER_MCP_LABEL_SCOPE", true);
  issues.push(...scope.issues);

  const iacRaw = raw("HETZNER_MCP_IAC_LABELS") ?? DEFAULT_IAC_LABELS;
  const iac = parseLabelTerms(iacRaw, "HETZNER_MCP_IAC_LABELS", false);
  issues.push(...iac.issues);
  const iacPolicy = parsed.success ? parsed.data.HETZNER_MCP_IAC_POLICY : "warn";
  if (iac.issues.length === 0 && iac.terms.length === 0 && iacPolicy !== "off") {
    issues.push(
      "HETZNER_MCP_IAC_LABELS: must not be empty while HETZNER_MCP_IAC_POLICY is not 'off'",
    );
  }

  const timeoutMs = parseIntInRange(
    raw("HETZNER_MCP_TIMEOUT_MS"),
    30_000,
    1000,
    300_000,
    "HETZNER_MCP_TIMEOUT_MS: must be an integer between 1000 and 300000 (milliseconds)",
    issues,
  );
  const actionWaitMs = parseIntInRange(
    raw("HETZNER_MCP_ACTION_WAIT_MS"),
    50_000,
    0,
    600_000,
    "HETZNER_MCP_ACTION_WAIT_MS: must be an integer between 0 and 600000 (milliseconds)",
    issues,
  );

  const firewallGuardPorts = parseGuardPorts(raw("HETZNER_MCP_FIREWALL_GUARD_PORTS"), issues);

  const costRaw = raw("HETZNER_MCP_MAX_MONTHLY_COST");
  let maxMonthlyCost: string | undefined;
  if (costRaw !== undefined) {
    if (MAX_MONTHLY_COST.test(costRaw)) {
      maxMonthlyCost = costRaw;
    } else {
      issues.push(
        "HETZNER_MCP_MAX_MONTHLY_COST: must be a non-negative decimal number with '.' as separator (net amount per month in the pricing currency, e.g. 5.00)",
      );
    }
  }

  if (issues.length > 0 || !parsed.success || token === undefined) {
    throw new ConfigError(issues);
  }
  const e = parsed.data;

  if (apiHost !== "api.hetzner.cloud") {
    warnings.push(
      `HETZNER_API_URL points to '${apiHost}' instead of api.hetzner.cloud; the API token is sent to that host.`,
    );
  }
  if (!e.HETZNER_MCP_REQUIRE_CONFIRMATION) {
    warnings.push(
      "HETZNER_MCP_REQUIRE_CONFIRMATION=false: destructive and cost-incurring tools run without confirmation and without a cost preview.",
    );
  }
  if (actionWaitMs > 55_000) {
    warnings.push(
      "HETZNER_MCP_ACTION_WAIT_MS is above 55000 ms; MCP clients with a 60 s request timeout may drop waiting tool calls. Prefer wait=false plus action_get.",
    );
  }

  return {
    apiUrl,
    projects: [{ name: projectName, token }],
    tokenSource,
    readOnly: e.HETZNER_MCP_READ_ONLY,
    toolsets,
    labelScope: scope.terms,
    iacPolicy: e.HETZNER_MCP_IAC_POLICY,
    iacMarkers: iac.terms,
    requireConfirmation: e.HETZNER_MCP_REQUIRE_CONFIRMATION,
    timeoutMs,
    actionWaitMs,
    firewallGuardPorts,
    allowCosts: e.HETZNER_MCP_ALLOW_COSTS,
    maxMonthlyCost,
    logLevel: e.HETZNER_MCP_LOG_LEVEL,
    warnings,
  };
}

/** Values masked literally in every log line. */
export function collectSecrets(config: Pick<Config, "projects">): string[] {
  return config.projects.map((project) => project.token);
}

/** Fields of the startup log line (01 §2.4). Never contains the token. */
export function startupFields(config: Config, version: string): Record<string, unknown> {
  return {
    version,
    apiUrl: config.apiUrl,
    project: config.projects[0].name,
    tokenSource: config.tokenSource,
    readOnly: config.readOnly,
    toolsets: [...config.toolsets],
    labelScope: formatTerms(config.labelScope),
    iacPolicy: config.iacPolicy,
    allowCosts: config.allowCosts,
    ...(config.maxMonthlyCost !== undefined && { maxMonthlyCost: config.maxMonthlyCost }),
  };
}
