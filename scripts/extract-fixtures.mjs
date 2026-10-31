#!/usr/bin/env node
// Generates tests/fixtures/<operationId>.json from the Hetzner Cloud OpenAPI spec (01 §9.4).
//
//   node scripts/extract-fixtures.mjs [--spec <cloud.spec.json>] [--check]
//
// Without --spec the spec is downloaded into a temp directory and this script is re-run with
// --spec. The spec itself is never checked in. Fixtures are never edited by hand.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_URL = "https://docs.hetzner.cloud/cloud.spec.json";
const SCRIPT = fileURLToPath(import.meta.url);
const FIXTURE_DIR = resolve(dirname(SCRIPT), "..", "tests", "fixtures");

// Binding and complete list of 1.0 operationIds (01 §9.4, 05 K-09). Neither extend nor shorten.
export const OPERATION_IDS = [
  // cross-cutting
  "get_action",
  "get_actions",
  "get_pricing",
  // core
  "list_servers",
  "get_server",
  "create_server",
  "update_server",
  "delete_server",
  "poweron_server",
  "shutdown_server",
  "reboot_server",
  "poweroff_server",
  "reset_server",
  "rebuild_server",
  "change_server_type",
  "change_server_protection",
  // info
  "list_server_types",
  "list_images",
  "list_locations",
  // actions
  "list_server_actions",
  "list_volume_actions",
  "list_firewall_actions",
  "list_image_actions",
  // ssh_keys
  "list_ssh_keys",
  "get_ssh_key",
  "create_ssh_key",
  "update_ssh_key",
  // firewalls
  "list_firewalls",
  "get_firewall",
  "create_firewall",
  "update_firewall",
  "set_firewall_rules",
  "apply_firewall_to_resources",
  "remove_firewall_from_resources",
  // storage
  "list_volumes",
  "get_volume",
  "create_volume",
  "update_volume",
  "attach_volume",
  "detach_volume",
  "resize_volume",
  "change_volume_protection",
  "get_image",
  "update_image",
  "change_image_protection",
  "create_server_image",
  "enable_server_backup",
  "disable_server_backup",
  // resources (03 §6.2)
  "list_primary_ips",
  "list_floating_ips",
  "list_networks",
  "list_load_balancers",
];

const SENSITIVE_KEYS = new Set(["root_password", "password"]);

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Resolves a local `#/...` $ref against the spec root. */
function deref(spec, node) {
  let cur = node;
  const seen = new Set();
  while (isObject(cur) && typeof cur.$ref === "string") {
    if (seen.has(cur.$ref)) throw new Error(`circular $ref ${cur.$ref}`);
    seen.add(cur.$ref);
    let target = spec;
    for (const part of cur.$ref.replace(/^#\//, "").split("/")) {
      target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    if (target === undefined) throw new Error(`unresolved $ref ${cur.$ref}`);
    cur = target;
  }
  return cur;
}

/** First value of an OpenAPI `examples` (object of {value} or 3.1 array of plain values). */
function firstExample(examples) {
  if (Array.isArray(examples)) return examples.length > 0 ? { value: examples[0] } : undefined;
  if (isObject(examples)) {
    const first = Object.values(examples)[0];
    if (isObject(first) && "value" in first) return { value: first.value };
  }
  return undefined;
}

/** Sample builder (01 §9.4 step 3). */
export function sample(spec, schemaIn, depth = 0) {
  if (depth > 40) return null;
  const schema = deref(spec, schemaIn);
  if (!isObject(schema)) return null;

  const ex = firstExample(schema.examples);
  if (ex) return ex.value;
  if ("example" in schema) return schema.example;

  // Composition keywords are not covered by 01 §9.4: allOf is merged, oneOf/anyOf take the first branch.
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((s) => sample(spec, s, depth + 1));
    return parts.every(isObject) ? Object.assign({}, ...parts) : (parts[0] ?? null);
  }
  for (const key of ["oneOf", "anyOf"]) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      return sample(spec, schema[key][0], depth + 1);
    }
  }

  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null") ?? "null";
  if (!type) type = isObject(schema.properties) ? "object" : undefined;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  switch (type) {
    case "object": {
      const out = {};
      if (isObject(schema.properties)) {
        for (const [k, v] of Object.entries(schema.properties)) {
          out[k] = sample(spec, v, depth + 1);
        }
      }
      return out;
    }
    case "array":
      return [sample(spec, schema.items ?? {}, depth + 1)];
    case "string":
      return "string";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

/** Replaces sensitive keys that occur in the schema (step 4). Applied to the built sample. */
function maskSensitive(node) {
  if (Array.isArray(node)) return node.map(maskSensitive);
  if (!isObject(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = SENSITIVE_KEYS.has(k) ? `SENSITIVE-${k}` : maskSensitive(v);
  }
  return out;
}

function sortKeys(node) {
  if (Array.isArray(node)) return node.map(sortKeys);
  if (!isObject(node)) return node;
  const out = {};
  for (const k of Object.keys(node).sort()) out[k] = sortKeys(node[k]);
  return out;
}

/** Finds operation by operationId. */
function findOperation(spec, operationId) {
  for (const item of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (isObject(op) && op.operationId === operationId) return op;
    }
  }
  return undefined;
}

/** First 2xx response with an application/json body (step 2); undefined when there is none. */
function successSchemaOrExample(spec, op) {
  const codes = Object.keys(op.responses ?? {})
    .filter((c) => /^2\d\d$/.test(c))
    .sort();
  for (const code of codes) {
    const res = deref(spec, op.responses[code]);
    const media = res?.content?.["application/json"];
    if (media) return media;
  }
  return undefined;
}

export function buildFixture(spec, operationId, source) {
  const op = findOperation(spec, operationId);
  if (!op) throw new Error(`operationId not found in spec: ${operationId}`);
  const media = successSchemaOrExample(spec, op);
  if (!media) return undefined; // 204 / no JSON body
  const ex = firstExample(media.examples);
  const body = ex
    ? ex.value
    : "example" in media
      ? media.example
      : sample(spec, media.schema ?? {});
  return { $source: source, ...sortKeys(maskSensitive(body)) };
}

const LINE_WIDTH = 100;

/**
 * JSON with 2-space indentation, keys sorted. Arrays of scalars that fit into one line are kept
 * on one line, so the files are stable under `biome format` (lineWidth 100).
 */
function stringify(node, indent = "", lead = indent.length, trailing = 0) {
  if (Array.isArray(node)) {
    if (node.length === 0) return "[]";
    if (node.every((v) => !isObject(v) && !Array.isArray(v))) {
      const flat = `[${node.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (lead + flat.length + trailing <= LINE_WIDTH) return flat;
    }
    const inner = `${indent}  `;
    return `[\n${node
      .map((v, i) => inner + stringify(v, inner, inner.length, i < node.length - 1 ? 1 : 0))
      .join(",\n")}\n${indent}]`;
  }
  if (isObject(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0) return "{}";
    const inner = `${indent}  `;
    return `{\n${keys
      .map((k, i) => {
        const head = `${inner}${JSON.stringify(k)}: `;
        return head + stringify(node[k], inner, head.length, i < keys.length - 1 ? 1 : 0);
      })
      .join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(node);
}

function render(fixture) {
  const { $source, ...rest } = fixture;
  return `${stringify({ $source, ...sortKeys(rest) })}\n`;
}

function parseArgs(argv) {
  const args = { check: false, spec: undefined, etag: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--spec") args.spec = argv[++i];
    else if (a === "--etag") args.etag = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

async function download() {
  const dir = mkdtempSync(join(tmpdir(), "hetzner-spec-"));
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const specPath = join(dir, "cloud.spec.json");
  writeFileSync(specPath, Buffer.from(await res.arrayBuffer()));
  const meta = { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
  writeFileSync(`${specPath}.meta.json`, JSON.stringify(meta));
  return { dir, specPath };
}

function readMeta(specPath) {
  const p = `${specPath}.meta.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

function isoDate(lastModified) {
  const d = lastModified ? new Date(lastModified) : new Date();
  return d.toISOString().slice(0, 10);
}

function run(args) {
  const specPath = resolve(args.spec);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const meta = readMeta(specPath);
  const etag = args.etag ?? meta.etag;
  const source = etag ? `cloud.spec.json etag ${etag} ${isoDate(meta.lastModified)}` : undefined;
  if (!source && !args.check) {
    throw new Error(
      "ETag unknown: pass --etag or provide <spec>.meta.json (written by the download)",
    );
  }

  const drift = [];
  const skipped = [];
  let written = 0;
  if (!args.check) mkdirSync(FIXTURE_DIR, { recursive: true });

  for (const id of OPERATION_IDS) {
    const fx = buildFixture(spec, id, source ?? "unknown");
    if (!fx) {
      skipped.push(id);
      continue;
    }
    const file = join(FIXTURE_DIR, `${id}.json`);
    if (args.check) {
      if (!existsSync(file)) {
        drift.push(`${id}: missing`);
        continue;
      }
      const current = JSON.parse(readFileSync(file, "utf8"));
      const { $source: curSource, ...curRest } = current;
      const { $source: _s, ...newRest } = fx;
      const same = JSON.stringify(sortKeys(curRest)) === JSON.stringify(sortKeys(newRest));
      const sourceSame = !source || curSource === source;
      if (!same || !sourceSame) {
        drift.push(`${id}: ${same ? "$source differs" : "content differs"}`);
      }
    } else {
      writeFileSync(file, render(fx));
      written++;
    }
  }

  if (skipped.length > 0) console.error(`no JSON body (skipped): ${skipped.join(", ")}`);
  if (args.check) {
    if (drift.length > 0) {
      console.error(`fixture drift:\n  ${drift.join("\n  ")}`);
      return 1;
    }
    console.error(`fixtures up to date (${OPERATION_IDS.length - skipped.length} files)`);
    return 0;
  }
  console.error(`wrote ${written} fixtures to ${FIXTURE_DIR}`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.spec) return run(args);

  // No --spec: download into a temp directory and re-invoke this script with --spec.
  const { dir, specPath } = await download();
  try {
    const argv = [SCRIPT, "--spec", specPath, ...(args.check ? ["--check"] : [])];
    return spawnSync(process.execPath, argv, { stdio: "inherit" }).status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
