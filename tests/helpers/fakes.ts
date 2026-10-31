import { type Config, TOOLSET_NAMES } from "../../src/config.js";

/** Token of makeConfig(); findSensitive() reports every occurrence (01 §9.2). */
export const TEST_TOKEN = "test-token-SECRET";

/** A complete Config with test defaults (01 §9.2). */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiUrl: "https://api.hetzner.test/v1",
    projects: [{ name: "test", token: TEST_TOKEN }],
    tokenSource: "HETZNER_TOKEN",
    readOnly: false,
    toolsets: new Set(TOOLSET_NAMES), // all on in tests; registry tests pass toolsets explicitly
    labelScope: [],
    iacPolicy: "warn",
    iacMarkers: [
      { key: "managed-by", value: "terraform" },
      { key: "managed_by", value: "terraform" },
    ],
    requireConfirmation: true,
    timeoutMs: 30_000,
    actionWaitMs: 50_000,
    firewallGuardPorts: [22],
    allowCosts: true,
    maxMonthlyCost: undefined,
    logLevel: "error",
    warnings: [],
    ...overrides,
  };
}
