# Configuration

All settings are environment variables. Set them in the `env` block of your MCP client (see [clients](clients.md)). The server validates everything at startup, collects every problem and exits with code 1 and a readable message if anything is wrong. It never contacts Hetzner at startup; the first request happens with the first tool call.

Blank values count as "not set". There are no defaults for credentials.

## Overview

| Variable | Default | Purpose |
|---|---|---|
| [`HETZNER_TOKEN`](#token) | (required) | API token of the Hetzner Cloud project |
| [`HCLOUD_TOKEN`](#token) | none | Alias for `HETZNER_TOKEN` |
| [`HETZNER_API_URL`](#api-url) | `https://api.hetzner.cloud/v1` | API base URL |
| [`HETZNER_MCP_PROJECT_NAME`](#project-name) | `default` | Name of the project in log lines |
| [`HETZNER_MCP_TOOLSETS`](#toolsets) | `core,info,actions,ssh_keys` | Enabled toolsets, or `all` |
| [`HETZNER_MCP_READ_ONLY`](#read-only-mode) | `false` | Register read-only tools only |
| [`HETZNER_MCP_LABEL_SCOPE`](#label-scope) | empty (off) | Confine changes to labelled resources |
| [`HETZNER_MCP_IAC_POLICY`](#infrastructure-as-code-check) | `warn` | `off`, `warn` or `block` |
| [`HETZNER_MCP_IAC_LABELS`](#infrastructure-as-code-check) | `managed-by=terraform,managed_by=terraform` | Labels that mark infrastructure-as-code resources |
| [`HETZNER_MCP_REQUIRE_CONFIRMATION`](#confirmation) | `true` | Destructive and cost-incurring tools need `confirm: true` |
| [`HETZNER_MCP_ALLOW_COSTS`](#cost-controls) | `true` | `false` removes the cost-incurring tools |
| [`HETZNER_MCP_MAX_MONTHLY_COST`](#cost-controls) | empty (off) | Per-call limit for the added net monthly cost |
| [`HETZNER_MCP_FIREWALL_GUARD_PORTS`](#firewall-lock-out-warning) | `22` | TCP ports covered by the lock-out warning |
| [`HETZNER_MCP_TIMEOUT_MS`](#timeouts-and-waiting) | `30000` | HTTP timeout per request, 1000 to 300000 |
| [`HETZNER_MCP_ACTION_WAIT_MS`](#timeouts-and-waiting) | `50000` | Wait for Hetzner actions, 0 to 600000 |
| [`HETZNER_MCP_LOG_LEVEL`](#logging) | `info` | `debug`, `info`, `warn` or `error` |

Boolean variables accept the values that Zod's `stringbool` accepts (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`, `y`/`n`, `enabled`/`disabled`, case-insensitive); anything else fails with `<NAME>: must be true or false`.

A commented template of all variables is in [`.env.example`](../.env.example).

## Token

| Variable | Rule |
|---|---|
| `HETZNER_TOKEN` | Required unless `HCLOUD_TOKEN` is set. Must not contain whitespace or control characters. The format and length of a Hetzner token are not documented, so they are not checked. |
| `HCLOUD_TOKEN` | Alias, same rules. If both are set to different values the server refuses to start; if both are equal that is fine. |

A token belongs to exactly one Hetzner Cloud project, so the server works on exactly one project. The startup log names the variable the token came from (`tokenSource`), never its value.

Create the token in the Hetzner Cloud Console under *Security > API Tokens* of the project. A **Read-only** token is enough for every read tool; with it, write tools fail with a `forbidden` error (see [troubleshooting](troubleshooting.md#403-hetzner-denied-the-operation)). Combine a Read-only token with `HETZNER_MCP_READ_ONLY=true` so the write tools are not even offered.

## API URL

`HETZNER_API_URL` defaults to `https://api.hetzner.cloud/v1`. It exists for tests, proxies and local stubs. Rules:

- It must be an `https` URL. `http` is accepted only for `localhost`, `*.localhost`, `[::1]` and `127.x.x.x` IPv4 literals.
- Trailing slashes are removed.
- If the host is not `api.hetzner.cloud`, the server logs a warning at startup, because **the API token is sent to that host**.
- **The URL must not contain credentials** (`https://user:pass@host/...`). The URL appears in the startup log and in error messages, so credentials in it would be written there. Pass the token only through `HETZNER_TOKEN`.

## Project name

`HETZNER_MCP_PROJECT_NAME` (default `default`) names the project in the audit log, so log lines of several server instances (for example production and staging) can be told apart. It must match `^[a-z][a-z0-9-]{0,31}$`. It has no effect on which project is used; that is decided by the token.

## Toolsets

`HETZNER_MCP_TOOLSETS` is a comma-separated list. `all` enables every toolset. An unknown name (also next to `all`) is an error:

```text
HETZNER_MCP_TOOLSETS: unknown toolset '<name>' (valid: core, info, actions, ssh_keys, firewalls, storage, all)
```

| Toolset | Default | Tools | Purpose |
|---|:---:|:---:|---|
| `core` | yes | 10 | Read, update, power, protect, create, delete, rebuild and resize servers |
| `info` | yes | 4 | Server types, images, locations and prices (read-only). Needed to call `server_create` sensibly; prices feed the cost previews. |
| `actions` | yes | 2 | `action_get` and `action_list`, to follow up on long-running operations |
| `ssh_keys` | yes | 5 | SSH keys. `server_create` requires at least one SSH key, so the model must be able to list them. |
| `firewalls` | no | 8 | Firewalls, rules and assignments. Rule changes can lock you out of servers, so enable it deliberately. |
| `storage` | no | 16 | Volumes, snapshots and backups. Costs and irreversible data loss, so enable it deliberately. |

The default set has 21 tools. The list of tools is fixed at startup; there is no runtime toggling. A tool that is not registered cannot be called and is not listed. Prompts are always registered, and so are resources (see [below](#prompts-and-resources)). Every tool is described in the [tools reference](tools-reference.md).

## Read-only mode

`HETZNER_MCP_READ_ONLY=true` registers only tools of kind _read_. Write and destructive tools are not listed and cannot be called. Prompts that create resources refuse with an error when read-only mode is on.

## Label scope

`HETZNER_MCP_LABEL_SCOPE` confines **changes** to resources that carry labels you choose, for example `env=staging` or `managed-by=mcp,team=web`. Default: empty (no scope).

Format: comma-separated `key=value` terms. Only equality; no `!=`, no `in`, no bare keys, and the value must not be empty. A key must be valid for Hetzner labels, must not start with `hetzner.cloud/` and may appear only once. Violations are startup errors, for example:

```text
HETZNER_MCP_LABEL_SCOPE: 'env' must have the form key=value (only equality, values must not be empty)
```

With a scope set:

- A tool may only **change** a resource that carries **every** scope label with exactly that value. Otherwise it is refused with `Resource <type> <id> is outside the label scope (HETZNER_MCP_LABEL_SCOPE=...). Only resources carrying these labels may be changed. Nothing was changed.`
- Calls that touch several resources check all of them, for example a firewall and every server named in `firewall_apply_to_resources`, or a volume and the server it is attached to.
- Resources a call only **references** are not checked. SSH keys, images, locations and server types used in `server_create` do not need the scope label.
- New resources get the scope labels automatically. Label sets of existing resources keep them: a label update without the scope key gets it added silently. Passing a scope key with a **different** value is rejected, not overwritten.
- A label selector given to `firewall_apply_to_resources` or `firewall_remove_from_resources` must contain every scope term as its own term (for example `env=staging,role=web`), so it cannot reach resources outside the scope.
- **Read tools do not filter.** Lists still show every resource of the project, with its labels. This is deliberate: the SSH keys needed by `server_create` carry no scope label, and listing is not a risk the scope is meant to cover.

The scope is a limit of this server. See [security](security.md#label-scope-and-infrastructure-as-code-check) for what it does not cover.

## Infrastructure-as-code check

Resources created by Terraform or OpenTofu and then changed by an assistant are overwritten at the next apply. The server can detect such resources by a label.

- `HETZNER_MCP_IAC_LABELS` (default `managed-by=terraform,managed_by=terraform`): comma-separated `key=value` terms. A resource counts as infrastructure-as-code if it carries **any one** of them (the terms are alternatives, unlike the label scope). An empty list is an error unless the policy is `off`.
- `HETZNER_MCP_IAC_POLICY`:

| Value | Behaviour |
|---|---|
| `off` | No check. |
| `warn` (default) | The change runs. A warning is added to the confirmation preview of destructive tools and to the result of every write tool (field `warnings`). |
| `block` | The change is refused: `... carries the infrastructure-as-code marker '<key>=<value>'. Changes are blocked (HETZNER_MCP_IAC_POLICY=block); change it in the infrastructure code instead. Nothing was changed.` |

The check only fires if your infrastructure code actually sets such a label on the resources. Whether the Terraform provider sets labels by itself is not verified.

New resources are never treated as infrastructure-as-code.

## Confirmation

`HETZNER_MCP_REQUIRE_CONFIRMATION` (default `true`). Tools that destroy data (kind _destructive_) and tools that can start or raise recurring costs have an extra optional `confirm` parameter. Without `confirm: true` they return an error with a preview of the effect and **change nothing**:

```text
Confirmation required. This would: <preview> Nothing was changed. Ask the user for approval, then call this tool again with confirm: true.
```

The preview names the target, shows warnings (infrastructure-as-code marker, active protection, firewall lock-out) and, for cost-incurring tools, an estimated cost.

> [!WARNING]
> `HETZNER_MCP_REQUIRE_CONFIRMATION=false` switches off **both** confirmations, the one for data loss and the one for costs, with a single setting. There is no separate switch for costs. At startup the server logs: `HETZNER_MCP_REQUIRE_CONFIRMATION=false: destructive and cost-incurring tools run without confirmation and without a cost preview.` Do not use it for interactive work.

`confirm: true` is set by the model, so it is not proof that a human approved. See [security](security.md#known-limitations).

## Cost controls

Two settings limit what an assistant can spend. Both are checks inside this server; neither is a setting at Hetzner, and neither replaces a Read-only token (see [security](security.md#cost-controls-and-their-limits)).

### `HETZNER_MCP_ALLOW_COSTS`

Default `true`. With `false`, the tools that can start or raise recurring costs are **not registered**: they are not listed and cannot be called (a call ends in a "not found" protocol error, as in read-only mode). In this version these are:

| Tool | Toolset |
|---|---|
| `server_create` | `core` |
| `server_change_type` | `core` |
| `volume_create` | `storage` |
| `volume_resize` | `storage` |
| `snapshot_create` | `storage` |
| `backup_enable` | `storage` |

The default toolsets then offer 19 instead of 21 tools. Tools that only delete or lower costs stay available. Prompts are still listed, but `provision_web_server` is refused when it is requested, because it needs these tools.

### `HETZNER_MCP_MAX_MONTHLY_COST`

Default: empty (no limit). A non-negative decimal number with `.` as separator, net, in the currency Hetzner reports for the project (the currency of the price list returned by `pricing_get`; the server does not convert), for example `5.00`. `0` is allowed and rejects every call that adds cost. Invalid values fail at startup:

```text
HETZNER_MCP_MAX_MONTHLY_COST: must be a non-negative decimal number with '.' as separator (net amount per month in the pricing currency, e.g. 5.00)
```

What the limit does:

- It applies to **one call** and compares the **additional net monthly cost** of that call (for example the monthly price of the new server, or the price difference of a resize) with the limit. It is not a budget: there is no counter and no sum over several calls. A model can stay below the limit with each call and still exceed it in total. Keep a total budget outside this server.
- It is checked **before** anything is written, and **also with `confirm: true`** and also with `HETZNER_MCP_REQUIRE_CONFIRMATION=false`. A call above the limit is rejected: `Cost limit exceeded: this call adds an estimated <amount> <currency>/month net, above HETZNER_MCP_MAX_MONTHLY_COST=<limit>. Nothing was changed. Tell the user; only the operator can raise the limit.`
- It **fails closed**. If Hetzner pricing cannot be loaded, or no price is listed for a part of the call, the call is rejected as well (`Cost limit check failed: ...`), because its cost is unknown.
- A call that does not add cost (for example a downgrade, or enabling backups that are already on) always passes.
- The comparison uses the monthly price reported by Hetzner, not an hourly price multiplied by hours. Whether Hetzner caps hourly billing at the monthly price is not verified.
- For `snapshot_create` the check uses an upper bound (the price per GB times the size of the server's primary disk), because the real snapshot size is known only after creation. Whether the snapshot size can exceed the disk size is not verified.
- Without the setting, no pricing request is made for the check.

## Firewall lock-out warning

`HETZNER_MCP_FIREWALL_GUARD_PORTS` (default `22`): comma-separated TCP ports, 1 to 65535, at most 10, duplicates removed. When `firewall_set_rules` would leave one of these ports without any inbound TCP rule for IPv4, for IPv6 or for both, where the firewall had one before, the preview and the result carry a lock-out warning. The warning never blocks anything. Add the port if you run SSH on a non-standard port. Limits of the check: [security](security.md#limits-of-the-lock-out-warning).

Invalid values fail at startup: `HETZNER_MCP_FIREWALL_GUARD_PORTS: '<value>' must be a list of TCP ports between 1 and 65535 (comma-separated, at most 10)`.

## Timeouts and waiting

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `HETZNER_MCP_TIMEOUT_MS` | `30000` | 1000 to 300000 | Timeout for each HTTP request to Hetzner |
| `HETZNER_MCP_ACTION_WAIT_MS` | `50000` | 0 to 600000 | How long a tool waits for the Hetzner actions it started. `0` never waits. |

Many Hetzner operations are asynchronous "actions". Tools that start actions have a `wait` parameter (default `true`). With `wait: true` the tool polls until the actions finish or `HETZNER_MCP_ACTION_WAIT_MS` has passed, and sends progress notifications if the client asked for them. If the time is up, the result reports the actions as `running` and says to follow up with `action_get`. With `wait: false` the tool returns immediately.

The default of 50 seconds leaves room under the 60 second request timeout that the MCP SDK uses by default; a progress notification extends that timeout only if the client asks for it. How long other clients wait is not documented. Above 55000 ms the server logs a warning at startup: `HETZNER_MCP_ACTION_WAIT_MS is above 55000 ms; MCP clients with a 60 s request timeout may drop waiting tool calls. Prefer wait=false plus action_get.`

## Logging

`HETZNER_MCP_LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`). Logs go to **stderr**, because stdout belongs to the MCP protocol. The format and what is never logged: [security](security.md#audit-log). At `debug` the gateway also logs each request (method, path, status, duration; no query, no body).

## Prompts and resources

Prompts and resources are always registered, independent of the toolset selection and of read-only mode.

- A prompt only gives the model instructions; every change still goes through the tools and their guards. `provision_web_server` creates resources, so it is refused when it is requested in read-only mode, with `HETZNER_MCP_ALLOW_COSTS=false`, or when a toolset it needs (`core`, `info`, `ssh_keys`, `firewalls`) is not enabled. `audit_project_security` and `review_costs` are read-only; if a toolset they use is missing, they tell the model to report which checks could not run.
- Resources are read-only. `hetzner://inventory` contains counts and IDs only, no names or labels.

## Examples

Read-only inspection of one project:

```text
HETZNER_TOKEN=<read-only token>
HETZNER_MCP_READ_ONLY=true
HETZNER_MCP_TOOLSETS=all
```

Staging project where the assistant may change only what carries a label, and may not order anything expensive:

```text
HETZNER_TOKEN=<read & write token>
HETZNER_MCP_TOOLSETS=core,info,actions,ssh_keys,firewalls
HETZNER_MCP_LABEL_SCOPE=env=staging
HETZNER_MCP_IAC_POLICY=block
HETZNER_MCP_MAX_MONTHLY_COST=5.00
```

No ordering at all (changes to existing resources remain possible):

```text
HETZNER_TOKEN=<read & write token>
HETZNER_MCP_ALLOW_COSTS=false
```
