# Hetzner Cloud MCP Server

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the **Hetzner Cloud API**. It lets an AI assistant such as Claude inspect and manage the servers, SSH keys, firewalls, volumes, snapshots and backups of one Hetzner Cloud project, with guardrails around every change that can destroy data or cost money.

> [!WARNING]
> This server acts with the permissions of the Hetzner Cloud API token you give it. Anything that token may do, the connected AI client can do, and some of it costs money. Use a **dedicated project with its own token**, and a **Read-only token** wherever you do not need changes. The built-in controls (read-only mode, label scope, cost limit, confirmation) narrow what the server does, but they live in the same process and do not replace token permissions. See [Security](#security).

## Highlights

- **45 tools in 6 toolsets**, enabled per toolset. The default set (`core`, `info`, `actions`, `ssh_keys`) has 21 tools; `firewalls` and `storage` are opt-in.
- **Cost awareness.** Tools that can start or raise recurring costs show an estimated monthly cost in their confirmation preview. `HETZNER_MCP_ALLOW_COSTS=false` removes them entirely, and `HETZNER_MCP_MAX_MONTHLY_COST` rejects any single call above a net monthly amount.
- **Guardrails.** Read-only mode, a label scope that confines changes to labelled resources, an infrastructure-as-code check (warn or block), and a preview-then-`confirm: true` flow for destructive and cost-incurring operations.
- **Lock-out warning.** Replacing the rules of a firewall shows a diff and warns when SSH would no longer be reachable from any address.
- **No root passwords.** Servers are created with SSH keys only; root passwords and cloud-init user data are never returned or logged.
- **3 guided prompts** (security audit, cost review, provision a web server) and **3 MCP resources** (inventory, price list, one server).
- **Structured, paginated output** with output schemas. The API token is masked in every log line.
- Works with Claude Desktop, Claude Code, VS Code, Cursor and any stdio MCP client. Requires Node.js 22 or newer.

## How it works

Your MCP client starts the server as a local child process and talks to it over stdio. Every tool call passes the guards, then goes through a single gateway that is the only code that talks to the Hetzner Cloud API.

![Architecture: the MCP client talks JSON-RPC over stdio to the server, whose guards, toolsets and gateway call the Hetzner Cloud API](https://raw.githubusercontent.com/ChristophEnglisch/hetzner-model-context-protocol/main/docs/diagrams/architecture.svg)

### What a destructive call looks like

A destructive tool never acts on the first call. It returns a preview of what would happen and changes nothing. Only after you approve does the assistant repeat the call with `confirm: true`. Tools that can incur costs work the same way and add the estimated cost to the preview.

![Sequence of a destructive call: the first server_delete call returns a preview and changes nothing, the repeated call with confirm: true deletes the server](https://raw.githubusercontent.com/ChristophEnglisch/hetzner-model-context-protocol/main/docs/diagrams/destructive-call.svg)

## Quick start

**Requirements:** Node.js 22 or newer, a Hetzner Cloud project with an API token, and an MCP client.

### 1. Create an API token

In the Hetzner Cloud Console, open your project and go to _Security > API Tokens_. For a first trial create a **Read-only** token. Use a Read & Write token only when you want the assistant to change things. Copy the token into a safe place.

Details: [docs/getting-started.md](docs/getting-started.md).

### 2. Configure your MCP client

Example for Claude Code (other clients: [docs/clients.md](docs/clients.md)):

```bash
claude mcp add --transport stdio \
  --env HETZNER_TOKEN='${HETZNER_TOKEN}' \
  --env HETZNER_MCP_READ_ONLY=true \
  hetzner -- npx -y hetzner-model-context-protocol
```

Or as JSON (Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hetzner": {
      "command": "npx",
      "args": ["-y", "hetzner-model-context-protocol"],
      "env": {
        "HETZNER_TOKEN": "<api-token>",
        "HETZNER_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

### 3. Ask your first question

> _List the servers in my Hetzner project and tell me which ones are switched off._

If you get an answer, you are done. If not, see [docs/troubleshooting.md](docs/troubleshooting.md).

## Configuration

All settings are environment variables. Only the token is required.

| Variable                           | Default                                     | Purpose                                                                           |
| ---------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `HETZNER_TOKEN`                    | (required)                                  | API token of the project; `HCLOUD_TOKEN` is accepted as an alias                  |
| `HETZNER_API_URL`                  | `https://api.hetzner.cloud/v1`              | API base URL; `https` required (`http` only for localhost)                        |
| `HETZNER_MCP_PROJECT_NAME`         | `default`                                   | Name of the project in log lines                                                  |
| `HETZNER_MCP_TOOLSETS`             | `core,info,actions,ssh_keys`                | Enabled toolsets, or `all`                                                        |
| `HETZNER_MCP_READ_ONLY`            | `false`                                     | Register read-only tools only                                                     |
| `HETZNER_MCP_LABEL_SCOPE`          | empty (off)                                 | `key=value` terms; changes are limited to resources carrying all of them          |
| `HETZNER_MCP_IAC_POLICY`           | `warn`                                      | `off`, `warn` or `block` for resources that carry an infrastructure-as-code label |
| `HETZNER_MCP_IAC_LABELS`           | `managed-by=terraform,managed_by=terraform` | Labels that mark a resource as managed by infrastructure code                     |
| `HETZNER_MCP_REQUIRE_CONFIRMATION` | `true`                                      | Destructive and cost-incurring tools need `confirm: true`                         |
| `HETZNER_MCP_ALLOW_COSTS`          | `true`                                      | `false` removes the tools that can start or raise recurring costs                 |
| `HETZNER_MCP_MAX_MONTHLY_COST`     | empty (off)                                 | Rejects a call whose added net monthly cost is above this amount                  |
| `HETZNER_MCP_FIREWALL_GUARD_PORTS` | `22`                                        | TCP ports covered by the firewall lock-out warning                                |
| `HETZNER_MCP_TIMEOUT_MS`           | `30000`                                     | HTTP timeout per request to Hetzner                                               |
| `HETZNER_MCP_ACTION_WAIT_MS`       | `50000`                                     | How long a tool waits for Hetzner actions to finish                               |
| `HETZNER_MCP_LOG_LEVEL`            | `info`                                      | `debug`, `info`, `warn` or `error` (stderr)                                       |

Full reference with validation rules and examples: [docs/configuration.md](docs/configuration.md).

## Toolsets and tools

Tools are named `<domain>_<verb>`. Only the **default** toolsets are enabled unless you set `HETZNER_MCP_TOOLSETS`. In read-only mode only tools of kind _read_ are registered.

| Toolset     | Default | Tools                                                                                                                                                                                                                                                                      |
| ----------- | :-----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`      |   yes   | `server_list`, `server_get`, `server_update`, `server_power`, `server_power_force` (destructive), `server_protection_set` (destructive), `server_create` (costs), `server_delete` (destructive), `server_rebuild` (destructive), `server_change_type` (destructive, costs) |
| `info`      |   yes   | `catalog_server_types`, `catalog_images`, `catalog_locations`, `pricing_get`                                                                                                                                                                                               |
| `actions`   |   yes   | `action_get`, `action_list`                                                                                                                                                                                                                                                |
| `ssh_keys`  |   yes   | `ssh_key_list`, `ssh_key_get`, `ssh_key_create`, `ssh_key_update`, `ssh_key_delete` (destructive)                                                                                                                                                                          |
| `firewalls` |   no    | `firewall_list`, `firewall_get`, `firewall_create`, `firewall_update`, `firewall_set_rules` (destructive), `firewall_apply_to_resources`, `firewall_remove_from_resources`, `firewall_delete` (destructive)                                                                |
| `storage`   |   no    | `volume_*` (9 tools), `snapshot_*` (5 tools), `backup_enable` (costs), `backup_disable` (destructive)                                                                                                                                                                      |

"costs" marks tools that can start or raise recurring costs (6 tools in total). Details for every tool (parameters, outputs, annotations): [docs/tools-reference.md](docs/tools-reference.md).

## Prompts and resources

**Prompts** are guided workflows built on the tools. They appear in your client's prompt picker (in Claude Code as slash commands).

| Prompt                   | What it does                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `audit_project_security` | Read-only security review (firewalls, exposed ports, backups, protection) with prioritized findings |
| `review_costs`           | Read-only review of the monthly cost with a list of savings candidates                              |
| `provision_web_server`   | Creates a web server with an SSH key and a firewall for SSH, HTTP and HTTPS; shows costs first      |

**Resources** are read-only JSON documents. They are registered independently of the toolset selection.

| URI                      | Content                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `hetzner://inventory`    | Counts of the project's resources by type, with the IDs of cost-relevant ones (no names or labels) |
| `hetzner://servers/{id}` | One server with the same fields as `server_get`                                                    |
| `hetzner://pricing`      | Compact price list of the project                                                                  |

## Security

- **Least privilege first.** Use a project that contains only what the assistant may touch, and a Read-only token when no changes are needed. The server cannot see or limit what a token is allowed to do.
- **Confirmation.** Destructive tools and tools that can incur costs return a preview first and need `confirm: true` (`HETZNER_MCP_REQUIRE_CONFIRMATION`).
- **Blast-radius limits.** `HETZNER_MCP_READ_ONLY`, `HETZNER_MCP_LABEL_SCOPE`, `HETZNER_MCP_IAC_POLICY`, `HETZNER_MCP_ALLOW_COSTS` and `HETZNER_MCP_MAX_MONTHLY_COST`. These are limits of this server, not of the token: anyone who holds the token can bypass them.
- **No secrets in output or logs.** The token is masked on stderr; root passwords and cloud-init user data never appear in results.
- **Prompt injection.** Treat names, labels and descriptions coming from Hetzner as data. The server instructions and the shipped prompts say so explicitly.

Threat model, hardening checklist and the known limits of each control: [docs/security.md](docs/security.md) and [SECURITY.md](SECURITY.md).

## Example prompts

- "Which servers do I have, and what do they cost per month?"
- "Run the `review_costs` prompt and tell me what I could delete."
- "Create a small server named `web-1` in `fsn1` with my SSH key `laptop`. Show me the cost first." _(needs `core`, `info`, `ssh_keys`; costs money)_
- "Which firewalls expose port 3306 to the whole internet?" _(needs the `firewalls` toolset)_
- "Make a snapshot of `web-1` before the upgrade." _(needs `storage`; costs money)_
- "Run `audit_project_security` and list the findings by severity."

## Documentation

| Document                                           | Content                                                         |
| -------------------------------------------------- | --------------------------------------------------------------- |
| [docs/getting-started.md](docs/getting-started.md) | Project and token setup, first run, MCP Inspector               |
| [docs/configuration.md](docs/configuration.md)     | Environment reference, toolsets, safety controls, cost controls |
| [docs/clients.md](docs/clients.md)                 | Claude Desktop, Claude Code, VS Code, Cursor, generic clients   |
| [docs/tools-reference.md](docs/tools-reference.md) | Every tool, prompt and resource in detail                       |
| [docs/security.md](docs/security.md)               | Threat model, guard chain, hardening, known limitations         |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Symptoms, causes, fixes                                         |
| [docs/architecture.md](docs/architecture.md)       | Components, flows, design decisions, adding a tool              |

## Contributing and license

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Released under the [MIT License](LICENSE).

Architecture follows keycloak-model-context-protocol.
