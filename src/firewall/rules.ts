// Firewall rule diff and lock-out check (03 §3, F-03). Pure functions, no I/O.
// Deliberately small (03 §7): normalisation, diff, the rule of 03 §3.4 – no CIDR containment,
// no other firewalls, no outbound rules.

/** Input as Hetzner delivers it (GET /firewalls/{id}) and as firewall_set_rules accepts it (SPEC Rule). */
export interface FirewallRule {
  direction: "in" | "out";
  protocol: "tcp" | "udp" | "icmp" | "esp" | "gre";
  port?: string | null;
  source_ips?: readonly string[];
  destination_ips?: readonly string[];
  description?: string | null;
}

export type Family = "ipv4" | "ipv6" | "unknown";
/** `text` = canonical form, or the trimmed raw value if unparseable. */
export interface Cidr {
  readonly text: string;
  readonly family: Family;
}

export type PortSpec =
  | { kind: "none" } // icmp, esp, gre: port is ignored
  | { kind: "all" } // tcp/udp without port (03 §3.3, not documented)
  | { kind: "range"; from: number; to: number }
  | { kind: "raw"; text: string }; // unparseable; covers nothing

export interface NormalizedRule {
  readonly direction: "in" | "out";
  readonly protocol: FirewallRule["protocol"];
  readonly port: PortSpec;
  /** source_ips for in, destination_ips for out; sorted, unique. */
  readonly ips: readonly Cidr[];
  /** Identity for the diff (03 §3.2). */
  readonly key: string;
}

export interface RuleDiff {
  readonly added: readonly NormalizedRule[];
  readonly removed: readonly NormalizedRule[];
  readonly unchanged: readonly NormalizedRule[];
}

export interface Lockout {
  readonly port: number;
  readonly lost: "all" | "ipv4" | "ipv6";
}

/** Target entry of a firewall (only what appliedServerIds reads). */
export interface AppliedTo {
  readonly type: string;
  readonly server?: { readonly id: number } | null;
  readonly applied_to_resources?: readonly {
    readonly type: string;
    readonly server?: { readonly id: number } | null;
  }[];
}

// --- normalisation (03 §3.2) -----------------------------------------------------------------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

function canonicalIpv4(text: string): string | undefined {
  const m = IPV4.exec(text);
  if (!m) return undefined;
  const [octets, prefix] = [m.slice(1, 5).map(Number), Number(m[5])];
  if (octets.some((o) => o > 255) || prefix > 32) return undefined;
  return `${octets.join(".")}/${prefix}`;
}

function parseGroups(part: string): number[] | undefined {
  if (part === "") return [];
  const groups = part.split(":");
  if (!groups.every((g) => HEX_GROUP.test(g))) return undefined;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** RFC 5952 §4: lower case, no leading zeros, longest run of ≥ 2 zero groups as `::` (first on a tie). */
function canonicalIpv6(text: string): string | undefined {
  const slash = text.indexOf("/");
  if (slash < 0) return undefined;
  const addr = text.slice(0, slash).toLowerCase();
  const prefixText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > 128) return undefined;
  if (addr.includes(".") || !addr.includes(":")) return undefined;

  let groups: number[];
  const halves = addr.split("::");
  if (halves.length > 2) return undefined;
  if (halves.length === 2) {
    const head = parseGroups(halves[0] ?? "");
    const tail = parseGroups(halves[1] ?? "");
    if (!head || !tail || head.length + tail.length > 7) return undefined;
    groups = [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    const all = parseGroups(addr);
    if (all?.length !== 8) return undefined;
    groups = all;
  }

  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  const body =
    best.len >= 2
      ? `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.len).join(":")}`
      : hex.join(":");
  return `${body}/${Number(prefixText)}`;
}

function toCidr(raw: string): Cidr {
  const text = raw.trim();
  const v4 = canonicalIpv4(text);
  if (v4 !== undefined) return { text: v4, family: "ipv4" };
  const v6 = canonicalIpv6(text);
  if (v6 !== undefined) return { text: v6, family: "ipv6" };
  return { text, family: "unknown" };
}

function toPort(rule: FirewallRule): PortSpec {
  if (rule.protocol !== "tcp" && rule.protocol !== "udp") return { kind: "none" };
  const text = (rule.port ?? "").trim();
  if (text === "") return { kind: "all" };
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(text);
  if (m) {
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from >= 1 && from <= to && to <= 65535) return { kind: "range", from, to };
  }
  return { kind: "raw", text };
}

function portKey(port: PortSpec): string {
  switch (port.kind) {
    case "none":
      return "-";
    case "all":
      return "all";
    case "range":
      return `${port.from}-${port.to}`;
    case "raw":
      return `raw:${port.text}`;
  }
}

const byText = (a: { text: string }, b: { text: string }) =>
  a.text < b.text ? -1 : a.text > b.text ? 1 : 0;

export function normalizeRule(rule: FirewallRule): NormalizedRule {
  const rawIps = (rule.direction === "in" ? rule.source_ips : rule.destination_ips) ?? [];
  const unique = new Map<string, Cidr>();
  for (const cidr of rawIps.map(toCidr)) unique.set(cidr.text, cidr);
  const ips = [...unique.values()].sort(byText);
  const port = toPort(rule);
  const key = `${rule.direction}|${rule.protocol}|${portKey(port)}|${ips.map((c) => c.text).join(",")}`;
  return { direction: rule.direction, protocol: rule.protocol, port, ips, key };
}

/** Normalised rules as a set: duplicates merged by key, sorted by key. */
export function normalizeRules(rules: readonly FirewallRule[]): NormalizedRule[] {
  const byKey = new Map<string, NormalizedRule>();
  for (const rule of rules.map(normalizeRule)) byKey.set(rule.key, rule);
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function diffRules(
  oldRules: readonly FirewallRule[],
  newRules: readonly FirewallRule[],
): RuleDiff {
  const before = normalizeRules(oldRules);
  const after = normalizeRules(newRules);
  const beforeKeys = new Set(before.map((r) => r.key));
  const afterKeys = new Set(after.map((r) => r.key));
  return {
    added: after.filter((r) => !beforeKeys.has(r.key)),
    removed: before.filter((r) => !afterKeys.has(r.key)),
    unchanged: after.filter((r) => beforeKeys.has(r.key)),
  };
}

// --- lock-out check (03 §3.4) ----------------------------------------------------------------

function covers(rule: NormalizedRule, port: number): boolean {
  return (
    rule.direction === "in" &&
    rule.protocol === "tcp" &&
    (rule.port.kind === "all" ||
      (rule.port.kind === "range" && rule.port.from <= port && port <= rule.port.to))
  );
}

function hasSource(rules: readonly NormalizedRule[], port: number, family: Family): boolean {
  return rules.some((r) => covers(r, port) && r.ips.some((c) => c.family === family));
}

export function findLockouts(
  oldRules: readonly FirewallRule[],
  newRules: readonly FirewallRule[],
  ports: readonly number[],
): Lockout[] {
  const before = normalizeRules(oldRules);
  const after = normalizeRules(newRules);
  const lockouts: Lockout[] = [];
  for (const port of [...new Set(ports)].sort((a, b) => a - b)) {
    const old4 = hasSource(before, port, "ipv4");
    const old6 = hasSource(before, port, "ipv6");
    const new4 = hasSource(after, port, "ipv4");
    const new6 = hasSource(after, port, "ipv6");
    if ((old4 || old6) && !new4 && !new6) lockouts.push({ port, lost: "all" });
    else if (old4 && !new4) lockouts.push({ port, lost: "ipv4" });
    else if (old6 && !new6) lockouts.push({ port, lost: "ipv6" });
  }
  return lockouts;
}

/** True if at least one inbound TCP rule covers the port with an IPv4 or IPv6 source (03 §3.6 notes). */
export function allowsPort(rules: readonly FirewallRule[], port: number): boolean {
  const normalized = normalizeRules(rules);
  return hasSource(normalized, port, "ipv4") || hasSource(normalized, port, "ipv6");
}

export function hasInboundRule(rules: readonly FirewallRule[]): boolean {
  return rules.some((r) => r.direction === "in");
}

// --- texts (03 §3.6) -------------------------------------------------------------------------

const MAX_ADDRESSES = 5;

export function describeRule(rule: NormalizedRule): string {
  const head = `${rule.direction} ${rule.protocol}`;
  let port = "";
  switch (rule.port.kind) {
    case "all":
      port = " all ports";
      break;
    case "range":
      port =
        rule.port.from === rule.port.to
          ? ` ${rule.port.from}`
          : ` ${rule.port.from}-${rule.port.to}`;
      break;
    case "raw":
      port = ` port ${JSON.stringify(rule.port.text)}`;
      break;
    case "none":
      break;
  }
  const word = rule.direction === "in" ? "from" : "to";
  const shown = rule.ips.slice(0, MAX_ADDRESSES).map((c) => c.text);
  const rest = rule.ips.length - shown.length;
  const addresses =
    shown.length === 0 ? "no address" : `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
  return `${head}${port} ${word} ${addresses}`;
}

/** Distinct server IDs the firewall currently reaches: applied_to[type=server].server.id ∪ applied_to[].applied_to_resources[type=server].server.id. */
export function appliedServerIds(firewall: { applied_to: readonly AppliedTo[] }): Set<number> {
  const ids = new Set<number>();
  for (const target of firewall.applied_to) {
    if (target.type === "server" && target.server) ids.add(target.server.id);
    for (const r of target.applied_to_resources ?? []) {
      if (r.type === "server" && r.server) ids.add(r.server.id);
    }
  }
  return ids;
}
