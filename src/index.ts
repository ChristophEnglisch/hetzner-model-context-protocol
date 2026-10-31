#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type Config, ConfigError, collectSecrets, loadConfig } from "./config.js";
import { HttpHetznerGateway } from "./hetzner/gateway.js";
import { formatTerms } from "./labels.js";
import { createLogger } from "./logging.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

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

function main(): void {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : "Failed to load configuration."}\n`,
    );
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel, secrets: collectSecrets(config) });
  for (const warning of config.warnings) logger.warn(warning);

  // No network call at startup: the first request happens with the first tool call.
  const gateway = new HttpHetznerGateway(
    { apiUrl: config.apiUrl, token: config.projects[0].token, timeoutMs: config.timeoutMs },
    { logger },
  );
  const handle = serveStdio(() => createServer({ config, gateway, logger }), {
    onerror: (error) => logger.error("Transport error", { error: error.message }),
  });
  logger.info("hetzner-model-context-protocol started", startupFields(config, VERSION));

  const shutdown = (): void => {
    handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** True when this file is the process entry point (also through the npm bin symlink). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
