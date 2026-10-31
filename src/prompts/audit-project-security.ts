import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { hasControlChars } from "../guards.js";
import type { ToolContext } from "../tools/shared.js";
import { DATA_NOTICE, missingToolHint, policyLines, promptResult, q } from "./shared.js";

const DEFAULT_PORTS = [22, 3389, 3306, 5432, 6379, 27017, 9200];

/** Valid ports (1-65535) from a comma-separated list; the default if none remain. */
function parsePorts(value: string | undefined): number[] {
  const ports = (value ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
  return ports.length > 0 ? ports : DEFAULT_PORTS;
}

export function registerAuditProjectSecurity(server: McpServer, ctx: ToolContext): void {
  server.registerPrompt(
    "audit_project_security",
    {
      title: "Audit project security",
      description:
        "Read-only security review of the Hetzner Cloud project (firewalls, exposed ports, backups, protection) that produces a prioritized list of findings.",
      argsSchema: z.object({
        label_selector: z
          .string()
          .min(1)
          .max(1000)
          .refine((v) => !hasControlChars(v), "must not contain control characters")
          .optional()
          .describe(
            "Optional Hetzner label selector to limit the audit to some servers, e.g. 'env=prod'.",
          ),
        ports: z
          .string()
          .regex(/^\s*\d{1,5}(\s*,\s*\d{1,5})*\s*$/)
          .optional()
          .describe(
            "Comma-separated TCP ports that should not be open to everyone (default: 22,3389,3306,5432,6379,27017,9200).",
          ),
      }),
    },
    ({ label_selector, ports }) => {
      const project = q(ctx.config.projects[0].name);
      const policy = policyLines(ctx);
      const scope = label_selector
        ? `servers matching the label selector ${q(label_selector)} (pass it as label_selector to server_list)`
        : "all servers";
      const text = `Perform a read-only security audit of the Hetzner Cloud project ${project}. Do not change anything.

${DATA_NOTICE}
${missingToolHint("firewall_list or firewall_get", "firewalls")} Report which checks you could not perform because of this.
${policy ? `${policy}\n` : ""}Scope: ${scope}.
Sensitive TCP ports: ${parsePorts(ports).join(", ")}.

Collect evidence with:

1. server_list (page through all results with page and per_page): for each server note status, public IPv4 and IPv6, the firewalls applied to it and their status, backup_window and protection. Use server_get where the list lacks a field.
2. firewall_list and firewall_get: the rules and applied_to of every firewall. An inbound tcp rule whose source_ips contain 0.0.0.0/0 or ::/0 and whose port or port range covers a sensitive port exposes that port to the whole internet; a port of 'any' covers all ports. A firewall without any inbound rule drops all inbound traffic.
3. For every server, check and report:
   a. no firewall applied although the server has a public IPv4 or IPv6 (high; you cannot see which services run on it, so say so);
   b. a firewall that exposes a sensitive port to 0.0.0.0/0 or ::/0 (high for database and remote-desktop ports; medium for SSH, which should be narrowed to known addresses);
   c. a firewall with status pending on the server (info);
   d. backups disabled, i.e. backup_window is null (medium);
   e. delete or rebuild protection disabled (medium for servers that look like production, otherwise low).
4. Password login for root cannot be checked through the Hetzner API. List it as "not checked" and recommend verifying "PasswordAuthentication no" in the SSH daemon configuration of each server.

Present the result as a prioritized findings list: for each finding give severity (critical, high, medium, low, info), the affected server or firewall ID, evidence (tool and values), risk, and a concrete recommendation. Mention when a finding concerns a resource managed by infrastructure as code, because the fix belongs in that code. End with a short summary of what is in good shape. Suggest fixes but do not apply them.`;
      return promptResult(`Security audit of project ${ctx.config.projects[0].name}`, text);
    },
  );
}
