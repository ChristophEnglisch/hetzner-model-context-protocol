import { Client, type ProgressCallback } from "@modelcontextprotocol/client";
import { type CallToolResult, InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { type Config, collectSecrets, type ToolsetName } from "../../src/config.js";
import type { HetznerGateway } from "../../src/hetzner/gateway.js";
import { createLogger, type Logger } from "../../src/logging.js";
import { createServer } from "../../src/server.js";
import { TOOLSETS } from "../../src/tools/index.js";
import type { ToolDefinition } from "../../src/tools/shared.js";
import { FakeHetzner } from "./fake-hetzner.js";
import { makeConfig } from "./fakes.js";
import { findSensitive } from "./sensitive.js";

export interface HarnessDeps {
  config: Config;
  gateway: HetznerGateway;
  logger: Logger;
}

export interface CallOptions {
  onprogress?: ProgressCallback;
  /** Client-side cancellation (T-D15). */
  signal?: AbortSignal;
}

export interface Harness {
  client: Client;
  fake: FakeHetzner;
  config: Config;
  logs: string[];
  logger: Logger;
  /** Calls a tool; afterwards asserts that neither the result nor the logs carry sensitive values. */
  call(
    name: string,
    args?: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<CallToolResult>;
  /** Closes client and server; asserts that every request hit a route. */
  close(): Promise<void>;
}

/**
 * Builds the server with `build` on top of a FakeHetzner gateway and connects an SDK client over an
 * in-memory transport (01 §9.2).
 */
export async function startHarnessWith(
  build: (deps: HarnessDeps) => McpServer,
  configOverrides: Partial<Config> = {},
): Promise<Harness> {
  const config = makeConfig(configOverrides);
  const logs: string[] = [];
  const logger = createLogger({
    level: "debug",
    secrets: collectSecrets(config),
    write: (line) => logs.push(line),
  });
  const fake = new FakeHetzner();
  const gateway = fake.gateway(
    { apiUrl: config.apiUrl, token: config.projects[0].token, timeoutMs: config.timeoutMs },
    logger,
  );
  const server = build({ config, gateway, logger });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    fake,
    config,
    logs,
    logger,
    call: async (name, args = {}, options = {}) => {
      const result = (await client.callTool(
        { name, arguments: args },
        {
          ...(options.onprogress && { onprogress: options.onprogress }),
          ...(options.signal && { signal: options.signal }),
        },
      )) as CallToolResult;
      expect(findSensitive({ result, logs }, config.projects[0].token)).toEqual([]);
      return result;
    },
    close: async () => {
      await client.close();
      await server.close();
      expect(fake.unmatched).toEqual([]);
    },
  };
}

/** The real server (`createServer`) on a FakeHetzner gateway (01 §9.2). */
export function startHarness(configOverrides: Partial<Config> = {}): Promise<Harness> {
  return startHarnessWith((deps) => createServer(deps), configOverrides);
}

/** Registers the given tool definitions on an own McpServer (define-tool tests, not via TOOLSETS). */
export function startToolHarness(
  tools: readonly ToolDefinition[],
  configOverrides: Partial<Config> = {},
): Promise<Harness> {
  return startHarnessWith((deps) => {
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    for (const tool of tools) tool.register(server, deps);
    return server;
  }, configOverrides);
}

export function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

/** The parsed field object of every log line with the given message (e.g. "tool_call"). */
export function logFields(logs: readonly string[], message: string): Record<string, unknown>[] {
  const marker = ` ${message} `;
  return logs
    .filter((line) => line.includes(marker))
    .map(
      (line) =>
        JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as Record<string, unknown>,
    );
}

/**
 * Temporarily puts tool definitions into a toolset of the real registry and returns the restore
 * function. Lets the registry and tools/list tests run against a filled registry while the real
 * toolsets are still empty; call the restore function in a finally block or afterEach.
 */
export function stubToolset(name: ToolsetName, tools: readonly ToolDefinition[]): () => void {
  const original = TOOLSETS[name];
  TOOLSETS[name] = tools;
  return () => {
    TOOLSETS[name] = original;
  };
}
