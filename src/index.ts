#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, collectSecrets, loadConfig } from "./config.js";
import { HttpHetznerGateway } from "./hetzner/gateway.js";
import { createLogger } from "./logging.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";

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
  logger.info("hetzner-model-context-protocol started", {
    version: VERSION,
    apiUrl: config.apiUrl,
    project: config.projects[0].name,
    readOnly: config.readOnly,
    toolsets: [...config.toolsets],
    allowCosts: config.allowCosts,
  });

  const shutdown = (): void => {
    handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
