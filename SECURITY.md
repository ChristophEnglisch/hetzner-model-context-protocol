# Security Policy

## Supported versions

| Version | Supported                        |
| ------- | -------------------------------- |
| 1.x     | Yes, the latest 1.x release      |
| 0.x     | Yes, the latest 0.x release only |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub Private Vulnerability Reporting:
<https://github.com/ChristophEnglisch/hetzner-model-context-protocol/security/advisories/new>

Please include affected version, configuration (without secrets), reproduction steps and the expected impact.

### Response targets

These are goals, not guarantees. This is a volunteer-maintained project.
- Acknowledgement: within 5 business days
- Initial assessment: within 10 business days
- Fix or mitigation for confirmed high/critical issues: target 30 days

Reporters are credited in the advisory unless they prefer otherwise.

## Scope

In scope: the code in this repository and the published npm package `hetzner-model-context-protocol` (tool handlers, configuration handling, safety controls such as read-only mode, label scope and confirmation of destructive tools, credential handling, logging).

Out of scope: vulnerabilities in the Hetzner Cloud API itself, in the MCP SDK or other dependencies (report upstream), misconfiguration such as over-privileged accounts, and attacks that require an already compromised host or MCP client.

## Security model

- The server acts with the permissions of the configured Hetzner Cloud API token. Anything that token may do, the connected MCP client can do.
- Apply least privilege: use a dedicated Hetzner Cloud project with its own API token, and a read-only token wherever writes are not needed.
- Restrict the blast radius:
  - `HETZNER_MCP_READ_ONLY=true` registers read-only tools only.
  - `HETZNER_MCP_LABEL_SCOPE` limits which resources may be changed, by label.
  - Destructive tools require confirmation (`HETZNER_MCP_REQUIRE_CONFIRMATION`, default `true`).
  - Enable only the toolsets you need (`HETZNER_MCP_TOOLSETS`).
- Prompt injection: data stored in Hetzner Cloud (names, labels, descriptions, `user_data`) is untrusted input and may contain instructions aimed at the LLM. Hetzner data is returned as structured content, but the MCP client and model remain responsible for not following it. Keep a human in the loop for write operations and try the server against a test project first.
- The API token (`HETZNER_TOKEN`) is read from the environment only and must not appear in logs or tool output. Do not commit `.env` files.
