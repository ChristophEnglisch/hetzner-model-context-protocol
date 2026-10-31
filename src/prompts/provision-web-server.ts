import { completable, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { hasControlChars } from "../guards.js";
import { HOSTNAME_RE, type ToolContext } from "../tools/shared.js";
import {
  completeLocationNames,
  DATA_NOTICE,
  guardWritePrompt,
  policyLines,
  promptResult,
  q,
  splitList,
} from "./shared.js";

const noControl = (v: string) => !hasControlChars(v);
const NO_CONTROL = "must not contain control characters";

export function registerProvisionWebServer(server: McpServer, ctx: ToolContext): void {
  server.registerPrompt(
    "provision_web_server",
    {
      title: "Provision web server",
      description:
        "Guided workflow to create a web server with an SSH key, a firewall for SSH, HTTP and HTTPS, optional cloud-init, and to wait until it is running. Shows costs before every step.",
      argsSchema: z.object({
        name: z
          .string()
          .regex(HOSTNAME_RE)
          .refine(noControl, NO_CONTROL)
          .describe("Server name (a valid hostname, unique in the project)."),
        // completable() must wrap the inner schema: the SDK looks for it behind optional().
        location: completable(
          z
            .string()
            .min(1)
            .max(64)
            .refine(noControl, NO_CONTROL)
            .describe("Location name, e.g. one listed by catalog_locations."),
          (value) => completeLocationNames(ctx, value),
        ).optional(),
        server_type: z
          .string()
          .min(1)
          .max(64)
          .refine(noControl, NO_CONTROL)
          .optional()
          .describe("Server type name; if omitted the assistant proposes options with prices."),
        image: z
          .string()
          .min(1)
          .max(64)
          .refine(noControl, NO_CONTROL)
          .optional()
          .describe("Image name; if omitted the assistant proposes a current system image."),
        ssh_key: z
          .string()
          .min(1)
          .max(255)
          .refine(noControl, NO_CONTROL)
          .optional()
          .describe("Name or ID of an existing SSH key."),
        ssh_sources: z
          .string()
          .max(1000)
          .refine(noControl, NO_CONTROL)
          .optional()
          .describe("Comma-separated CIDRs allowed to reach SSH (port 22), e.g. '203.0.113.7/32'."),
      }),
    },
    ({ name, location, server_type, image, ssh_key, ssh_sources }) => {
      guardWritePrompt(ctx, "provision_web_server", ["core", "info", "ssh_keys", "firewalls"], {
        costs: true,
      });
      const project = q(ctx.config.projects[0].name);
      const policy = policyLines(ctx);
      const sources = splitList(ssh_sources);
      const sourceList = sources.map(q).join(", ");
      const text = `You are provisioning a web server named ${q(name)} in the Hetzner Cloud project ${project}.

Requested values (supplied by the user):
- location: ${location ? q(location) : "not set"}
- server type: ${server_type ? q(server_type) : "not set"}
- image: ${image ? q(image) : "not set"}
- SSH key: ${ssh_key ? q(ssh_key) : "not set"}
- SSH allowed from: ${sources.length ? sourceList : "not set"}

${DATA_NOTICE}
${policy ? `${policy}\n` : ""}Every change costs money or exposes the server. Before EVERY step that creates something, summarize it in one or two sentences and wait for the user's go-ahead. Creating tools first answer with a confirmation preview that includes the estimated monthly cost; show that cost to the user and call the tool again with confirm: true only after the user approved.

1. Location: ${location ? `use ${q(location)}; check that catalog_locations lists it.` : "call catalog_locations and let the user choose a location."}
2. Server type: ${server_type ? `check with catalog_server_types that ${q(server_type)} is available in the location and not deprecated.` : "call catalog_server_types and pricing_get and propose two or three small server types that are available in the location and not deprecated, each with its monthly net and gross price; let the user choose."}
3. Image: ${image ? `check with catalog_images that ${q(image)} exists for the architecture of the server type.` : "call catalog_images and propose a current Ubuntu or Debian system image for the architecture of the server type; let the user choose."}
4. SSH key: ${ssh_key ? `look up ${q(ssh_key)} with ssh_key_list (exact name or ID).` : "call ssh_key_list and let the user choose a key."} If the user has no key, ask for the public key and create it with ssh_key_create. Servers are created with SSH keys only; never ask for, set or show a root password.
5. Firewall: create one with firewall_create and these inbound rules only: tcp 80 and tcp 443 from 0.0.0.0/0 and ::/0; icmp from 0.0.0.0/0 and ::/0; tcp 22 ${sources.length ? `from ${sourceList}` : "from the addresses the user names (ask for their public IP address or network in CIDR notation); use 0.0.0.0/0 and ::/0 for SSH only if the user explicitly accepts SSH from everywhere"}. Do not add outbound rules.
6. cloud-init: only if the user wants software installed at first boot, draft a short cloud-init file, show it to the user and pass it as user_data after approval. Never put passwords, tokens or other secrets into user_data.
7. Create the server with server_create: name ${q(name)}, the chosen server type, image and location, the SSH key from step 4 and the firewall from step 5.
8. server_create waits for its actions. If an action is still reported as running, follow up with action_get; then confirm with server_get that the server status is running.
9. Finish with a short summary: server ID, public IPv4 and IPv6, firewall ID, the estimated monthly cost (net and gross), and that login works with the chosen SSH key.

If any step fails, stop, explain the error and propose how to proceed; do not delete or recreate anything on your own.`;
      return promptResult(`Provision web server ${name}`, text);
    },
  );
}
