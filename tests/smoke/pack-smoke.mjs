// Usage: npm run build && npm run test:smoke
//
// Packs the project exactly as `npm publish` would, installs the tarball into a
// throw-away directory and drives the *installed* binary over stdio. No network call to Hetzner is made.
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const BIN_NAME = "hetzner-model-context-protocol";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * The default tool set, derived from the built server (dist/config.js, dist/tools/index.js), not
 * hard-coded: whatever the default toolsets register must be what tools/list returns.
 */
async function defaultTools() {
  const { loadConfig } = await import(pathToFileURL(join(root, "dist", "config.js")).href);
  const { selectTools } = await import(pathToFileURL(join(root, "dist", "tools", "index.js")).href);
  return selectTools(loadConfig({ HETZNER_TOKEN: "smoke" })).map((tool) => tool.name);
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` - ${detail}` : ""}\n`);
  if (!ok) throw new Error(`Smoke check failed: ${name}${detail ? ` (${detail})` : ""}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function runUntilExit(command, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const workDir = mkdtempSync(join(tmpdir(), "hetzner-mcp-smoke-"));
try {
  if (!existsSync(join(root, "dist", "index.js"))) {
    process.stdout.write("dist/ missing, running npm run build ...\n");
    run(npm, ["run", "build"], { cwd: root });
  }

  // 1. pack
  const packDir = join(workDir, "pack");
  mkdirSync(packDir);
  const packJson = JSON.parse(
    run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: root }),
  );
  const packed = packJson[0];
  const files = packed.files.map((f) => f.path);
  check("tarball contains dist/index.js", files.includes("dist/index.js"));
  check(
    "tarball contains no sources, tests or env files",
    !files.some((f) => /^(src|tests|docs|\.github)\//.test(f) || /(^|\/)\.env/.test(f)),
    files.filter((f) => /^(src|tests|docs|\.github)\//.test(f) || /\.env/.test(f)).join(", "),
  );
  const tarball = join(packDir, packed.filename);

  // 2. install into a clean project
  const appDir = join(workDir, "app");
  mkdirSync(appDir);
  writeFileSync(join(appDir, "package.json"), '{ "name": "smoke-app", "private": true }\n');
  run(
    npm,
    ["install", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts", tarball],
    { cwd: appDir },
  );
  const installedDir = join(appDir, "node_modules", pkg.name);
  const entry = join(installedDir, "dist", "index.js");
  const bin = join(appDir, "node_modules", ".bin", BIN_NAME);
  check("binary is linked in node_modules/.bin", existsSync(bin));

  // 3. shebang and executable bit
  const firstLine = readFileSync(entry, "utf8").split("\n", 1)[0];
  check("entry point starts with the node shebang", firstLine === "#!/usr/bin/env node", firstLine);
  if (process.platform !== "win32") {
    check("entry point is executable", (statSync(entry).mode & 0o111) !== 0);
  }

  // 4. missing HETZNER_TOKEN -> exit 1 with a clear message, nothing on stdout
  const pathOnly = { PATH: process.env.PATH ?? "" };
  const missing = await runUntilExit(bin, pathOnly, 15_000);
  check("exits with code 1 without HETZNER_TOKEN", missing.code === 1, `exit ${missing.code}`);
  check(
    "error message names HETZNER_TOKEN",
    missing.stderr.includes("HETZNER_TOKEN"),
    missing.stderr,
  );
  check("nothing is written to stdout on config errors", missing.stdout === "", missing.stdout);

  // 5. MCP handshake against the installed binary
  const transport = new StdioClientTransport({
    command: bin,
    args: [],
    env: {
      ...pathOnly,
      HETZNER_TOKEN: "smoke",
      // Nothing listens on port 9; the handshake and tools/list never call the API.
      HETZNER_API_URL: "http://127.0.0.1:9",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "pack-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    const info = client.getServerVersion();
    check("initialize succeeds", info !== undefined);
    check(
      `serverInfo.version equals package.json (${pkg.version})`,
      info?.version === pkg.version,
      info?.version,
    );
    check("serverInfo.name is the package name", info?.name === pkg.name, info?.name);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = await defaultTools();
    check("the default toolsets register at least one tool", expected.length > 0);
    check(
      `tools/list returns exactly the default toolsets (${expected.length} tools)`,
      JSON.stringify(names) === JSON.stringify([...expected].sort()),
      names.join(", "),
    );
    check(
      "every tool has a title, output schema and annotations",
      tools.every((t) => t.title && t.outputSchema && t.annotations?.readOnlyHint !== undefined),
    );
  } finally {
    await client.close().catch(() => {});
  }

  process.stdout.write(
    `\nSmoke test passed (${checks.length} checks, ${pkg.name}@${pkg.version}).\n`,
  );
} catch (error) {
  process.stderr.write(`\nSmoke test FAILED: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
