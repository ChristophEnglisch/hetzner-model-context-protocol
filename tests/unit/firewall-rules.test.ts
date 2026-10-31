// Test table 03 §3.7 (F-1..F-25). The sentences of F-8/F-9/F-13/F-14 are checked through the
// tool preview in firewalls.test.ts (F-T1, F-T2 and the F-03 sentence tests there).
import { describe, expect, it } from "vitest";
import {
  allowsPort,
  appliedServerIds,
  describeRule,
  diffRules,
  type FirewallRule,
  findLockouts,
  hasInboundRule,
  normalizeRule,
} from "../../src/firewall/rules.js";

const A = "198.51.100.1/32";
const B = "198.51.100.2/32";
const any4 = "0.0.0.0/0";
const any6 = "::/0";
const G = [22];

function R(
  direction: "in" | "out",
  protocol: FirewallRule["protocol"],
  port: string | null,
  ips: string[],
  description?: string,
): FirewallRule {
  return {
    direction,
    protocol,
    port,
    ...(direction === "in" ? { source_ips: ips } : { destination_ips: ips }),
    ...(description !== undefined && { description }),
  };
}

const counts = (oldRules: FirewallRule[], newRules: FirewallRule[]) => {
  const d = diffRules(oldRules, newRules);
  return [d.added.length, d.removed.length, d.unchanged.length];
};

const F8_OLD = [R("in", "tcp", "22", [any4, any6]), R("in", "tcp", "443", [any4, any6])];
const F8_NEW = [R("in", "tcp", "443", [any4, any6])];

describe("firewall rule diff (03 §3.7)", () => {
  it.each<[string, FirewallRule[], FirewallRule[], number[], number[]?]>([
    [
      "F-1 order is ignored",
      [R("in", "tcp", "22", [A, B]), R("in", "tcp", "80", [any4])],
      [R("in", "tcp", "80", [any4]), R("in", "tcp", "22", [B, A])],
      [0, 0, 2],
    ],
    [
      "F-2 80-80 equals 80",
      [R("in", "tcp", "22", [any4])],
      [R("in", "tcp", "22-22", [any4])],
      [0, 0, 1],
    ],
    [
      "F-3 IPv6 notation is ignored",
      [R("in", "tcp", "22", ["2001:db8::/32"])],
      [R("in", "tcp", "22", ["2001:0DB8:0000::/32"])],
      [0, 0, 1],
    ],
    [
      "F-4 duplicate and unordered addresses collapse",
      [R("in", "tcp", "22", [B, A, A])],
      [R("in", "tcp", "22", [A, B])],
      [0, 0, 1],
    ],
    [
      "F-5 descriptions are ignored",
      [R("in", "tcp", "22", [any4], "ssh")],
      [R("in", "tcp", "22", [any4], "admin ssh")],
      [0, 0, 1],
    ],
    [
      "F-6 icmp port is ignored",
      [R("in", "icmp", "8", [any4])],
      [R("in", "icmp", null, [any4])],
      [0, 0, 1],
    ],
    [
      "F-7 narrowing the source is a change",
      [R("in", "tcp", "22", [any4, any6])],
      [R("in", "tcp", "22", ["203.0.113.7/32"])],
      [1, 1, 0],
      // Table 3.7 says "kein Lockout"; the exact rule of 3.4 gives ipv6 here (the only IPv6
      // source is gone, mirror image of F-10). The rule wins; see the no-lockout case below.
      [22],
    ],
    ["F-8 dropping the SSH rule", F8_OLD, F8_NEW, [0, 1, 1], [22]],
    ["F-9 removing all rules", F8_OLD, [], [0, 2, 0], [22]],
    [
      "F-10 only IPv6 remains",
      [R("in", "tcp", "22", [any4, any6])],
      [R("in", "tcp", "22", [any6])],
      [1, 1, 0],
      [22],
    ],
    [
      "F-11 ranges count",
      [R("in", "tcp", "1-1024", [any4])],
      [R("in", "tcp", "80", [any4]), R("in", "tcp", "443", [any4])],
      [2, 1, 0],
      [22],
    ],
    [
      "F-12 a wider range keeps 22",
      [R("in", "tcp", "22", [any4])],
      [R("in", "tcp", "20-30", [any4])],
      [1, 1, 0],
    ],
    ["F-13 22 was never allowed", [R("in", "tcp", "80", [any4])], [], [0, 1, 0]],
    ["F-16 udp does not count", [R("in", "udp", "22", [any4])], [], [0, 1, 0]],
    [
      "F-17 a rule without port allows all ports",
      [R("in", "tcp", null, [any4])],
      [R("in", "tcp", "80", [any4])],
      [1, 1, 0],
      [22],
    ],
    [
      "F-24 port any equals a rule without port",
      [R("in", "tcp", null, [any4])],
      [R("in", "tcp", "any", [any4])],
      [0, 0, 1],
    ],
    [
      "F-25 port any allows all ports",
      [R("in", "tcp", "any", [any4])],
      [R("in", "tcp", "80", [any4])],
      [1, 1, 0],
      [22],
    ],
    ["F-18 outbound rules are not checked", [R("out", "tcp", "443", [any4])], [], [0, 1, 0]],
    [
      "F-19 splitting a rule",
      [R("in", "tcp", "22", [A, B])],
      [R("in", "tcp", "22", [A]), R("in", "tcp", "22", [B])],
      [2, 1, 0],
    ],
    [
      "F-20 an unparseable source does not count",
      [R("in", "tcp", "22", [any4])],
      [R("in", "tcp", "22", ["10.0.0.300/32"])],
      [1, 1, 0],
      [22],
    ],
  ])("%s", (_name, oldRules, newRules, diff, lockedPorts = []) => {
    expect(counts(oldRules, newRules)).toEqual(diff);
    const lockouts = findLockouts(oldRules, newRules, G);
    expect(lockouts.map((l) => l.port)).toEqual(lockedPorts);
  });

  it("duplicate rules collapse", () => {
    const rule = R("in", "tcp", "22", [A]);
    expect(counts([rule, rule], [rule])).toEqual([0, 0, 1]);
  });

  it("F-7 narrowing to one source of the same family is no lockout (3.4 edge case)", () => {
    expect(
      findLockouts([R("in", "tcp", "22", [any4])], [R("in", "tcp", "22", ["203.0.113.7/32"])], G),
    ).toEqual([]);
  });

  it("F-7 as written in 3.7 loses the only IPv6 source (exact rule 3.4)", () => {
    expect(
      findLockouts(
        [R("in", "tcp", "22", [any4, any6])],
        [R("in", "tcp", "22", ["203.0.113.7/32"])],
        G,
      ),
    ).toEqual([{ port: 22, lost: "ipv6" }]);
  });

  it("F-8 reports lockout all for 22", () => {
    expect(findLockouts(F8_OLD, F8_NEW, G)).toEqual([{ port: 22, lost: "all" }]);
    expect(hasInboundRule(F8_NEW)).toBe(true);
  });

  it("F-9 reports lockout all and no inbound rule", () => {
    expect(findLockouts(F8_OLD, [], G)).toEqual([{ port: 22, lost: "all" }]);
    expect(hasInboundRule([])).toBe(false);
  });

  it("F-10 reports lockout ipv4", () => {
    expect(
      findLockouts([R("in", "tcp", "22", [any4, any6])], [R("in", "tcp", "22", [any6])], G),
    ).toEqual([{ port: 22, lost: "ipv4" }]);
  });

  it("reports lockout ipv6 when only IPv4 remains", () => {
    expect(
      findLockouts([R("in", "tcp", "22", [any4, any6])], [R("in", "tcp", "22", [any4])], G),
    ).toEqual([{ port: 22, lost: "ipv6" }]);
  });

  it("F-11 reports lockout all for 22 inside a dropped range", () => {
    expect(
      findLockouts(
        [R("in", "tcp", "1-1024", [any4])],
        [R("in", "tcp", "80", [any4]), R("in", "tcp", "443", [any4])],
        G,
      ),
    ).toEqual([{ port: 22, lost: "all" }]);
  });

  it("F-13 has no lockout but no inbound rule", () => {
    expect(findLockouts([R("in", "tcp", "80", [any4])], [], G)).toEqual([]);
    expect(hasInboundRule([])).toBe(false);
  });

  it("F-15 checks every guarded port", () => {
    const oldRules = [R("in", "tcp", "22", [any4]), R("in", "tcp", "2222", [any4])];
    const newRules = [R("in", "tcp", "22", [any4])];
    expect(counts(oldRules, newRules)).toEqual([0, 1, 1]);
    expect(findLockouts(oldRules, newRules, [22, 2222])).toEqual([{ port: 2222, lost: "all" }]);
  });

  it("checks guarded ports in ascending order", () => {
    expect(findLockouts([R("in", "tcp", null, [any4])], [], [2222, 22]).map((l) => l.port)).toEqual(
      [22, 2222],
    );
  });

  it("F-21 collects distinct applied server IDs", () => {
    const ids = appliedServerIds({
      applied_to: [
        { type: "server", server: { id: 1 } },
        {
          type: "label_selector",
          applied_to_resources: [
            { type: "server", server: { id: 1 } },
            { type: "server", server: { id: 2 } },
          ],
        },
      ],
    });
    expect([...ids].sort()).toEqual([1, 2]);
  });

  it("F-21 with no targets is empty", () => {
    expect(appliedServerIds({ applied_to: [] }).size).toBe(0);
  });

  it("F-22 lists all added rules for the diff", () => {
    const added = Array.from({ length: 12 }, (_, i) => R("in", "tcp", String(1000 + i), [any4]));
    expect(counts([], added)).toEqual([12, 0, 0]);
  });

  it.each([
    ["2001:DB8:0:0:1:0:0:1/128", "2001:db8::1:0:0:1/128"],
    ["2001:db8:0:0:0:0:2:1/64", "2001:db8::2:1/64"],
    ["::/0", "::/0"],
    ["2001:db8:0:1:1:1:1:1/64", "2001:db8:0:1:1:1:1:1/64"],
    ["2001:0db8:9a3b:ee58:05ca:990c:8bc9:c03b/128", "2001:db8:9a3b:ee58:5ca:990c:8bc9:c03b/128"],
    [" 2001:db8::/32 ", "2001:db8::/32"],
  ])("F-23 canonicalises IPv6 %s", (input, canonical) => {
    expect(normalizeRule(R("in", "tcp", "22", [input])).ips).toEqual([
      { text: canonical, family: "ipv6" },
    ]);
  });

  it.each([
    ["10.0.0.300/32"],
    ["10.0.0.1"],
    ["::ffff:10.0.0.1/128"],
    ["2001:db8::/129"],
    ["1:2:3:4:5:6:7:8:9/64"],
    ["2001:db8::1::2/64"],
  ])("treats %s as unparseable", (input) => {
    expect(normalizeRule(R("in", "tcp", "22", [input])).ips).toEqual([
      { text: input, family: "unknown" },
    ]);
  });

  it("canonicalises IPv4 octets", () => {
    expect(normalizeRule(R("in", "tcp", "22", ["010.0.0.1/8"])).ips).toEqual([
      { text: "10.0.0.1/8", family: "ipv4" },
    ]);
  });

  it("normalises ports and the key", () => {
    expect(normalizeRule(R("in", "tcp", " 80 ", [any4])).key).toBe("in|tcp|80-80|0.0.0.0/0");
    expect(normalizeRule(R("in", "tcp", "", [])).port).toEqual({ kind: "all" });
    expect(normalizeRule(R("in", "tcp", "any", [])).key).toBe("in|tcp|all|");
    expect(normalizeRule(R("in", "udp", " ANY ", [])).port).toEqual({ kind: "all" });
    expect(normalizeRule(R("in", "tcp", "anything", [])).port).toEqual({
      kind: "raw",
      text: "anything",
    });
    expect(normalizeRule(R("in", "tcp", "0", [])).port).toEqual({ kind: "raw", text: "0" });
    expect(normalizeRule(R("in", "tcp", "30-20", [])).port).toEqual({ kind: "raw", text: "30-20" });
    expect(normalizeRule(R("in", "tcp", "65536", [])).port).toEqual({ kind: "raw", text: "65536" });
    expect(normalizeRule(R("in", "gre", "5", [any4])).key).toBe("in|gre|-|0.0.0.0/0");
  });

  it("uses source_ips for in and destination_ips for out", () => {
    const rule: FirewallRule = {
      direction: "out",
      protocol: "tcp",
      port: "443",
      source_ips: [A],
      destination_ips: [B],
    };
    expect(normalizeRule(rule).ips.map((c) => c.text)).toEqual([B]);
  });

  it("allowsPort needs an inbound TCP rule with a parseable source", () => {
    expect(allowsPort([R("in", "tcp", "22", [any4])], 22)).toBe(true);
    expect(allowsPort([R("in", "tcp", "1-1024", [any6])], 22)).toBe(true);
    expect(allowsPort([R("in", "tcp", "80", [any4])], 22)).toBe(false);
    expect(allowsPort([R("in", "udp", "22", [any4])], 22)).toBe(false);
    expect(allowsPort([R("out", "tcp", "22", [any4])], 22)).toBe(false);
    expect(allowsPort([R("in", "tcp", "22", ["nonsense"])], 22)).toBe(false);
    expect(allowsPort([], 22)).toBe(false);
    expect(allowsPort([R("in", "tcp", "any", [any4])], 22)).toBe(true);
  });
});

describe("describeRule (03 §3.6)", () => {
  const d = (rule: FirewallRule) => describeRule(normalizeRule(rule));

  it.each<[FirewallRule, string]>([
    [R("in", "tcp", "22", [any6, any4]), "in tcp 22 from 0.0.0.0/0, ::/0"],
    [R("in", "tcp", "1024-5000", ["10.0.0.0/8"]), "in tcp 1024-5000 from 10.0.0.0/8"],
    [R("in", "udp", null, [any4]), "in udp all ports from 0.0.0.0/0"],
    [R("in", "tcp", "any", [any4]), "in tcp all ports from 0.0.0.0/0"],
    [R("in", "tcp", "anything", [any4]), 'in tcp port "anything" from 0.0.0.0/0'],
    [R("in", "icmp", null, [any4]), "in icmp from 0.0.0.0/0"],
    [R("out", "tcp", "443", [any4]), "out tcp 443 to 0.0.0.0/0"],
    [R("in", "tcp", "22", []), "in tcp 22 from no address"],
    [R("out", "esp", null, []), "out esp to no address"],
    [
      R("in", "tcp", "22", [
        "10.0.0.1/32",
        "10.0.0.2/32",
        "10.0.0.3/32",
        "10.0.0.4/32",
        "10.0.0.5/32",
        "10.0.0.6/32",
        "10.0.0.7/32",
      ]),
      "in tcp 22 from 10.0.0.1/32, 10.0.0.2/32, 10.0.0.3/32, 10.0.0.4/32, 10.0.0.5/32 and 2 more",
    ],
  ])("describes %j", (rule, text) => {
    expect(d(rule)).toBe(text);
  });
});
