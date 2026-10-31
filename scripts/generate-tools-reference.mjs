#!/usr/bin/env node
/**
 * Generates docs/tools-reference.md from the live MCP server (tools/list,
 * prompts/list, resources/templates/list).
 *
 * Usage (after `npm run build`; the npm scripts do that for you):
 *   node scripts/generate-tools-reference.mjs           write the file
 *   node scripts/generate-tools-reference.mjs --check   exit 1 if the file is stale
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = resolve(root, "docs/tools-reference.md");
const check = process.argv.includes("--check");

const load = (path) => import(pathToFileURL(resolve(root, "dist", path)).href);

async function listAll(method, key) {
  const items = [];
  let cursor;
  do {
    const page = await method(cursor ? { cursor } : undefined);
    items.push(...page[key]);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function collect() {
  const { createServer } = await load("server.js");
  const { TOOLSETS } = await load("tools/index.js");
  const { TOOLSET_NAMES } = await load("config.js");
  const { silentLogger } = await load("logging.js");

  // Not type-checked: a wrong field only shows up at runtime. Keep in sync with `Config` (src/config.ts).
  const config = {
    apiUrl: "https://hetzner.invalid/v1",
    projects: [{ name: "docs", token: "docs" }],
    tokenSource: "HETZNER_TOKEN",
    readOnly: false,
    toolsets: new Set(TOOLSET_NAMES),
    labelScope: [],
    iacPolicy: "warn",
    iacMarkers: [{ key: "managed-by", value: "terraform" }],
    requireConfirmation: true,
    timeoutMs: 1000,
    actionWaitMs: 1000,
    firewallGuardPorts: [22],
    allowCosts: true,
    maxMonthlyCost: undefined,
    logLevel: "error",
    warnings: [],
  };
  const gateway = {
    run() {
      throw new Error("The gateway must never be called while generating documentation.");
    },
  };
  const server = createServer({ config, gateway, logger: silentLogger });
  const client = new Client({ name: "docs-generator", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await listAll((p) => client.listTools(p), "tools");
    const prompts = await listAll((p) => client.listPrompts(p), "prompts");
    const resources = await listAll((p) => client.listResources(p), "resources");
    const templates = await listAll((p) => client.listResourceTemplates(p), "resourceTemplates");
    const toolsets = Object.entries(TOOLSETS).map(([name, defs]) => ({
      name,
      toolNames: defs.map((d) => d.name),
    }));
    const costNames = new Set(
      Object.values(TOOLSETS)
        .flat()
        .filter((d) => d.costs)
        .map((d) => d.name),
    );
    return { tools, prompts, resources, templates, toolsets, costNames };
  } finally {
    await client.close();
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const SAFE_INT = Number.MAX_SAFE_INTEGER;

const cell = (text) =>
  String(text ?? "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();

function typeOf(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" \\| ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const parts = [...new Set(variants.map(typeOf))];
    return parts.join(" \\| ");
  }
  const type = Array.isArray(schema.type) ? schema.type.join(" \\| ") : schema.type;
  if (type === "array") return `${typeOf(schema.items)}[]`;
  if (type === "integer" || type === "number") {
    const bounds = [];
    if (schema.minimum !== undefined && Math.abs(schema.minimum) < SAFE_INT) {
      bounds.push(`min ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && Math.abs(schema.maximum) < SAFE_INT) {
      bounds.push(`max ${schema.maximum}`);
    }
    return bounds.length > 0 ? `${type} (${bounds.join(", ")})` : type;
  }
  if (type === "string" && schema.format) return `string (${schema.format})`;
  return type ?? "any";
}

/** Flattens an object schema into rows; nested objects (also inside arrays) get dotted paths. */
function rowsOf(schema, prefix = "", depth = 0) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const rows = [];
  for (const [name, prop] of Object.entries(props)) {
    const path = `${prefix}${name}`;
    const nested = prop.type === "array" ? prop.items : prop;
    const isObject = nested?.type === "object" && nested.properties;
    rows.push({
      name: path,
      type: isObject && prop.type !== "array" ? "object" : typeOf(prop),
      required: required.has(name),
      def: prop.default,
      description: prop.description ?? "",
    });
    if (isObject && depth < 3) {
      const childPrefix = `${path}${prop.type === "array" ? "[]" : ""}.`;
      rows.push(...rowsOf(nested, childPrefix, depth + 1));
    }
  }
  return rows;
}

function table(rows, { withRequired }) {
  const head = withRequired
    ? ["Name", "Type", "Required", "Default", "Description"]
    : ["Name", "Type", "Description"];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const row of rows) {
    const cols = withRequired
      ? [
          `\`${row.name}\``,
          `\`${row.type}\``,
          row.required ? "yes" : "no",
          row.def === undefined ? "" : `\`${JSON.stringify(row.def)}\``,
          cell(row.description),
        ]
      : [`\`${row.name}\``, `\`${row.type}\``, cell(row.description)];
    lines.push(`| ${cols.map((c) => (c === "" ? " " : c)).join(" | ")} |`);
  }
  return lines.join("\n");
}

function badges(tool, costNames) {
  const a = tool.annotations ?? {};
  const out = [];
  if (a.readOnlyHint) out.push("read-only");
  else if (a.destructiveHint) out.push("destructive");
  else out.push("write");
  if (a.idempotentHint) out.push("idempotent");
  else if (!a.readOnlyHint) out.push("not idempotent");
  if (costNames.has(tool.name)) out.push("can incur costs");
  if (tool.inputSchema?.properties?.confirm) out.push("requires `confirm: true`");
  return out;
}

function renderTool(tool, costNames) {
  const a = tool.annotations ?? {};
  const lines = [];
  lines.push(`#### ${tool.title ?? tool.name}`, "");
  lines.push(`\`${tool.name}\``, "");
  lines.push(`**${badges(tool, costNames).join(" · ")}**`, "");
  lines.push(tool.description ?? "", "");
  lines.push(
    `Annotations: \`readOnlyHint=${a.readOnlyHint}\`, \`destructiveHint=${a.destructiveHint}\`, \`idempotentHint=${a.idempotentHint}\`, \`openWorldHint=${a.openWorldHint}\``,
    "",
  );
  const params = rowsOf(tool.inputSchema);
  lines.push("**Parameters**", "");
  lines.push(params.length > 0 ? table(params, { withRequired: true }) : "_None._", "");
  const outputs = rowsOf(tool.outputSchema);
  lines.push("**Output** (`structuredContent`)", "");
  lines.push(outputs.length > 0 ? table(outputs, { withRequired: false }) : "_None._", "");
  return lines.join("\n");
}

function render({ tools, prompts, resources, templates, toolsets, costNames }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const out = [];
  out.push(
    "<!--",
    "  GENERATED FILE - DO NOT EDIT.",
    "  Source: tools/list, prompts/list and resources/templates/list of the built server.",
    "  Regenerate with `npm run docs:tools`; `npm run docs:check` fails when this file is stale.",
    "-->",
    "",
    "# Tools reference",
    "",
    // No package version here: release PRs bump it without regenerating this file,
    // which would make `docs:check` fail on every release.
    "> Generated from the server definitions. Do not edit by hand.",
    "",
    `The server exposes ${tools.length} tools in ${toolsets.length} toolsets, ${prompts.length} prompts and ${templates.length + resources.length} resources. Which tools are registered depends on \`HETZNER_MCP_TOOLSETS\` (default: \`core,info,actions,ssh_keys\`), \`HETZNER_MCP_READ_ONLY\` (hides every tool that is not read-only) and \`HETZNER_MCP_ALLOW_COSTS=false\` (hides every tool that can start or raise recurring costs). See [configuration](configuration.md).`,
    "",
    "Conventions:",
    "",
    "- The server works on exactly one Hetzner Cloud project: the one the API token belongs to. Tools take no project argument.",
    '- Destructive tools take an additional optional `confirm` parameter. Tools that can start or raise recurring costs take it too (marked "can incur costs"; `HETZNER_MCP_ALLOW_COSTS=false` removes them, `HETZNER_MCP_MAX_MONTHLY_COST` limits them). Unless `HETZNER_MCP_REQUIRE_CONFIRMATION=false`, the first call returns a preview (with the estimated cost where it applies) and changes nothing; call again with `confirm: true` after the user approved.',
    "- Tools that trigger Hetzner actions take an optional `wait` parameter (default `true`) and return the actions in `actions`. The server polls for up to `HETZNER_MCP_ACTION_WAIT_MS` and sends progress notifications if the client asked for them; with `wait: false`, or when the time is up, the actions are reported as `running` and `action_get` follows up.",
    "- List tools are paginated with `page` and `per_page` and return `{ items, page, per_page, next_page, total_entries }`.",
    "- With `HETZNER_MCP_LABEL_SCOPE` set, write tools only touch resources that carry every scope label, and new resources get the scope labels automatically.",
    "- Results carry a short neutral summary in `content` and the data in `structuredContent`. Errors are returned with `isError: true`.",
    "",
    "## Overview",
    "",
    "| Toolset | Tool | Kind | Description |",
    "|---|---|---|---|",
  );
  for (const set of toolsets) {
    for (const name of set.toolNames) {
      const tool = byName.get(name);
      if (!tool) continue;
      const kind = tool.annotations?.readOnlyHint
        ? "read"
        : tool.annotations?.destructiveHint
          ? "destructive"
          : "write";
      const first = (tool.description ?? "").split(/(?<=\.)\s+(?=[A-Z])/)[0];
      const note = costNames.has(name) ? "can incur costs" : "";
      out.push(
        `| \`${set.name}\` | [\`${name}\`](#${anchor(tool)}) | ${kind}${note ? ` (${note})` : ""} | ${cell(first)} |`,
      );
    }
  }
  out.push("");
  for (const set of toolsets) {
    out.push(`## Toolset \`${set.name}\``, "");
    for (const name of set.toolNames) {
      const tool = byName.get(name);
      if (tool) out.push(renderTool(tool, costNames));
    }
  }

  out.push("## Prompts", "");
  out.push(
    "Prompts are guided workflows that instruct the model to use the tools above. They only instruct the model; every change still goes through the tools, so label scope, cost limit and confirmation apply. A prompt that creates resources is refused in read-only mode and, where it needs cost tools, with `HETZNER_MCP_ALLOW_COSTS=false`. The prompts name the toolsets they need.",
    "",
  );
  for (const prompt of [...prompts].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`### ${prompt.title ?? prompt.name}`, "", `\`${prompt.name}\``, "");
    out.push(prompt.description ?? "", "");
    const args = prompt.arguments ?? [];
    if (args.length > 0) {
      out.push("| Argument | Required | Description |", "|---|---|---|");
      for (const arg of args) {
        out.push(`| \`${arg.name}\` | ${arg.required ? "yes" : "no"} | ${cell(arg.description)} |`);
      }
      out.push("");
    }
  }

  out.push("## Resources", "");
  out.push(
    "Read-only JSON resources, registered independently of the toolset selection.",
    "",
    "| URI | Name | Description |",
    "|---|---|---|",
  );
  const resourceRows = [
    ...resources.map((r) => ({ uri: r.uri, title: r.title ?? r.name, description: r.description })),
    ...templates.map((t) => ({
      uri: t.uriTemplate,
      title: t.title ?? t.name,
      description: t.description,
    })),
  ].sort((a, b) => a.uri.localeCompare(b.uri));
  const seen = new Set();
  for (const row of resourceRows) {
    // Listed concrete instances of a template would make the output depend on data.
    if (seen.has(row.uri)) continue;
    seen.add(row.uri);
    out.push(`| \`${row.uri}\` | ${cell(row.title)} | ${cell(row.description)} |`);
  }
  out.push("");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}`;
}

function anchor(tool) {
  return (tool.title ?? tool.name)
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");
}

const data = await collect();
const markdown = render(data);

if (check) {
  let current = "";
  try {
    current = await readFile(outFile, "utf8");
  } catch {
    // missing file counts as stale
  }
  if (current !== markdown) {
    process.stderr.write(
      "docs/tools-reference.md is out of date. Run `npm run docs:tools` and commit the result.\n",
    );
    process.exit(1);
  }
  process.stdout.write("docs/tools-reference.md is up to date.\n");
} else {
  await writeFile(outFile, markdown, "utf8");
  process.stdout.write(`Wrote docs/tools-reference.md (${data.tools.length} tools).\n`);
}
