<!--
  GENERATED FILE - DO NOT EDIT.
  Source: tools/list, prompts/list and resources/templates/list of the built server.
  Regenerate with `npm run docs:tools`; `npm run docs:check` fails when this file is stale.
-->

# Tools reference

> Generated from the server definitions. Do not edit by hand.

The server exposes 45 tools in 6 toolsets, 3 prompts and 3 resources. Which tools are registered depends on `HETZNER_MCP_TOOLSETS` (default: `core,info,actions,ssh_keys`), `HETZNER_MCP_READ_ONLY` (hides every tool that is not read-only) and `HETZNER_MCP_ALLOW_COSTS=false` (hides every tool that can start or raise recurring costs). See [configuration](configuration.md).

Conventions:

- The server works on exactly one Hetzner Cloud project: the one the API token belongs to. Tools take no project argument.
- Destructive tools take an additional optional `confirm` parameter. Tools that can start or raise recurring costs take it too (marked "can incur costs"; `HETZNER_MCP_ALLOW_COSTS=false` removes them, `HETZNER_MCP_MAX_MONTHLY_COST` limits them). Unless `HETZNER_MCP_REQUIRE_CONFIRMATION=false`, the first call returns a preview (with the estimated cost where it applies) and changes nothing; call again with `confirm: true` after the user approved.
- Tools that trigger Hetzner actions take an optional `wait` parameter (default `true`) and return the actions in `actions`. The server polls for up to `HETZNER_MCP_ACTION_WAIT_MS` and sends progress notifications if the client asked for them; with `wait: false`, or when the time is up, the actions are reported as `running` and `action_get` follows up.
- List tools are paginated with `page` and `per_page` and return `{ items, page, per_page, next_page, total_entries }`.
- With `HETZNER_MCP_LABEL_SCOPE` set, write tools only touch resources that carry every scope label, and new resources get the scope labels automatically.
- `server_rebuild` is marked "gated / not released": it is built and registered, but stays unreleased until the live check IT-05 confirms that SSH keys are injected again after a rebuild.
- Results carry a short neutral summary in `content` and the data in `structuredContent`. Errors are returned with `isError: true`.

## Overview

| Toolset | Tool | Kind | Description |
|---|---|---|---|
| `core` | [`server_list`](#list-servers) | read | Lists the servers of the Hetzner Cloud project, 25 per page by default, with status, type, location, public IPs, labels and protection. |
| `core` | [`server_get`](#get-server) | read | Returns one server with status, type, location, image, public and private network, firewalls, volumes, traffic counters (bytes), labels and protection. |
| `core` | [`server_update`](#update-server) | write | Renames a server and/or replaces its complete label set (labels not listed are removed; label-scope labels are kept automatically). |
| `core` | [`server_power`](#power-server-on-shut-down-or-reboot) | write | Starts a server (on), shuts it down gracefully via ACPI (shutdown) or reboots it gracefully via ACPI (reboot). |
| `core` | [`server_power_force`](#force-power-off-or-hard-reset-server) | destructive | Cuts power to a server (off) or cuts power and starts it again (reset), without letting the operating system stop gracefully; this is like pulling the power cord and can lose unsaved data or corrupt files. |
| `core` | [`server_protection_set`](#set-server-protection) | destructive | Turns delete and rebuild protection of a server on or off together (Hetzner currently requires both to have the same value). |
| `core` | [`server_create`](#create-server) | write (can incur costs) | Creates a new server from a server type, image and location, injecting the given SSH keys; root passwords are never created or returned, so at least one SSH key is required. |
| `core` | [`server_delete`](#delete-server) | destructive | Permanently deletes a server and all data on its disks; this cannot be undone. |
| `core` | [`server_rebuild`](#rebuild-server) | destructive (gated / not released) | Overwrites a server's disk with an image (a fresh system image, a snapshot or a backup), destroying all data on the server; the server is powered off first. |
| `core` | [`server_change_type`](#change-server-type) | destructive (can incur costs) | Changes the server type (cores, RAM, and optionally disk size) of a server that is powered off; Hetzner copies the disk and starts the server again. |
| `info` | [`catalog_server_types`](#list-orderable-server-types) | read | Lists Hetzner server types with CPU, memory, disk, architecture and the locations where they can be ordered. |
| `info` | [`catalog_images`](#list-images) | read | Lists images usable for servers. |
| `info` | [`catalog_locations`](#list-locations) | read | Lists Hetzner Cloud locations (city, country, network zone). |
| `info` | [`pricing_get`](#get-pricing) | read | Returns the account's Hetzner Cloud prices as delivered by Hetzner: currency, VAT rate, volume and snapshot price per GB and month, the backup surcharge, and (only if 'server_type' is given) that server type's prices in every location. |
| `actions` | [`action_get`](#get-an-action) | read | Returns the current state of one Hetzner action (status, progress, error) by ID. |
| `actions` | [`action_list`](#list-actions-of-a-resource) | read | Lists the Hetzner actions (power, rebuild, attach, snapshot and similar operations) of one server, volume, firewall or image, newest first by default. |
| `ssh_keys` | [`ssh_key_list`](#list-ssh-keys) | read | Lists the SSH keys stored in the Hetzner project with ID, name, fingerprint and labels. |
| `ssh_keys` | [`ssh_key_get`](#get-an-ssh-key) | read | Returns one SSH key by ID, including its public key text and fingerprint. |
| `ssh_keys` | [`ssh_key_create`](#create-an-ssh-key) | write | Adds a public SSH key to the Hetzner project so it can be used when creating servers. |
| `ssh_keys` | [`ssh_key_update`](#update-an-ssh-key) | write | Renames an SSH key and/or replaces its labels. |
| `ssh_keys` | [`ssh_key_delete`](#delete-an-ssh-key) | destructive | Deletes an SSH key from the Hetzner project; it can no longer be selected when creating servers. |
| `firewalls` | [`firewall_list`](#list-firewalls) | read | Lists firewalls of the project with their ID, name, labels, and rule and target counts. |
| `firewalls` | [`firewall_get`](#get-a-firewall) | read | Returns one firewall with all its rules and the resources it is applied to. |
| `firewalls` | [`firewall_create`](#create-a-firewall) | write | Creates a firewall with optional rules. |
| `firewalls` | [`firewall_update`](#update-a-firewalls-name-or-labels) | write | Renames a firewall and/or replaces its complete label set. |
| `firewalls` | [`firewall_set_rules`](#replace-all-rules-of-a-firewall) | destructive | Replaces ALL rules of a firewall with the given list; existing rules are discarded, and an empty list removes every rule. |
| `firewalls` | [`firewall_apply_to_resources`](#apply-a-firewall-to-servers) | write | Adds servers and/or label selectors as targets of a firewall, extending the existing targets. |
| `firewalls` | [`firewall_remove_from_resources`](#remove-a-firewall-from-servers) | write | Removes servers and/or label-selector targets from a firewall. |
| `firewalls` | [`firewall_delete`](#delete-a-firewall) | destructive | Permanently deletes a firewall and its rules. |
| `storage` | [`volume_list`](#list-volumes) | read | Lists block-storage volumes with size, status, location, the server each is attached to, labels and protection. |
| `storage` | [`volume_get`](#get-a-volume) | read | Returns one volume with size, status, location, attachment, device path, labels and delete protection. |
| `storage` | [`volume_create`](#create-a-volume) | write (can incur costs) | Creates a block-storage volume of 10 to 10240 GB, optionally attached to a server at creation. |
| `storage` | [`volume_attach`](#attach-a-volume-to-a-server) | write | Attaches a volume to a server in the same location. |
| `storage` | [`volume_detach`](#detach-a-volume) | write | Detaches a volume from the server it is attached to. |
| `storage` | [`volume_resize`](#resize-a-volume) | write (can incur costs) | Increases the size of a volume to the given number of GB. |
| `storage` | [`volume_update`](#update-a-volumes-name-or-labels) | write | Renames a volume and/or replaces its complete label set. |
| `storage` | [`volume_delete`](#delete-a-volume) | destructive | Permanently deletes a volume; all data on it is irreversibly destroyed. |
| `storage` | [`volume_protection_set`](#set-volume-delete-protection) | destructive | Turns delete protection of a volume on or off. |
| `storage` | [`snapshot_create`](#create-a-snapshot-of-a-server) | write (can incur costs) | Creates a snapshot image of a server's disk. |
| `storage` | [`snapshot_list`](#list-snapshots-and-backups) | read | Lists snapshot and backup images of the project with size, status, labels and the server they were created from. |
| `storage` | [`snapshot_update`](#update-a-snapshot-or-backup) | write | Changes the description and/or replaces the complete label set of a snapshot or backup image. |
| `storage` | [`snapshot_delete`](#delete-a-snapshot-or-backup) | destructive | Permanently deletes a snapshot or backup image. |
| `storage` | [`snapshot_protection_set`](#set-snapshot-delete-protection) | destructive | Turns delete protection of a snapshot on or off. |
| `storage` | [`backup_enable`](#enable-automatic-backups-for-a-server) | write (can incur costs) | Enables the automatic daily backup option for a server, which keeps up to seven backup images. |
| `storage` | [`backup_disable`](#disable-automatic-backups-for-a-server) | destructive | Disables the automatic backup option of a server and immediately deletes ALL its existing backup images, irreversibly. |

## Toolset `core`

#### List servers

`server_list`

**read-only · idempotent**

Lists the servers of the Hetzner Cloud project, 25 per page by default, with status, type, location, public IPs, labels and protection. Filter by exact name, label selector or status. It does not return networking, image, traffic or volume details; use server_get for one server.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | no |   | Only the server with exactly this name (names are unique per project). |
| `label_selector` | `string` | no |   | Hetzner label selector, e.g. 'env=prod,!temporary' or 'env in (staging,test)'. |
| `status` | `"running" \| "initializing" \| "starting" \| "stopping" \| "off" \| "deleting" \| "migrating" \| "rebuilding" \| "unknown"[]` | no |   | Only servers in one of these states. |
| `sort` | `"id" \| "id:asc" \| "id:desc" \| "name" \| "name:asc" \| "name:desc" \| "created" \| "created:asc" \| "created:desc"` | no |   | Sort order: field, field:asc or field:desc (fields: id, name, created). |
| `page` | `integer (min 1)` | no | `1` | Page number, starting at 1 (default 1). |
| `per_page` | `integer (min 1, max 50)` | no | `25` | Entries per page (default 25, at most 50). |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` |   |
| `items[].id` | `integer` | ID of the server. |
| `items[].name` | `string` | Name of the server (untrusted data). |
| `items[].status` | `"running" \| "initializing" \| "starting" \| "stopping" \| "off" \| "deleting" \| "migrating" \| "rebuilding" \| "unknown"` | Status of the server. |
| `items[].created` | `string` | Creation time (ISO 8601). |
| `items[].server_type` | `string` | Name of the server type, e.g. cx22. |
| `items[].location` | `string` | Name of the location, e.g. fsn1. |
| `items[].ipv4` | `string \| null` | Public IPv4 address, or null. |
| `items[].ipv6` | `string \| null` | Public IPv6 network (/64), or null. |
| `items[].locked` | `boolean` | True while another action runs on the server. |
| `items[].labels` | `object` | Labels (untrusted data). |
| `items[].protection` | `object` |   |
| `items[].protection.delete` | `boolean` | Delete protection. |
| `items[].protection.rebuild` | `boolean` | Rebuild protection (servers only). |
| `page` | `integer` | Page number of this result. |
| `per_page` | `integer` | Page size used. |
| `next_page` | `integer \| null` | Next page number, or null if this is the last page. |
| `total_entries` | `integer \| null` | Total number of entries, or null if Hetzner did not report it. |

#### Get server

`server_get`

**read-only · idempotent**

Returns one server with status, type, location, image, public and private network, firewalls, volumes, traffic counters (bytes), labels and protection. It does not return prices, the root password or cloud-init user data. A locked server has another action running; follow it with the actions tools.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the server. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server` | `object` |   |
| `server.id` | `integer` | ID of the server. |
| `server.name` | `string` | Name of the server (untrusted data). |
| `server.status` | `"running" \| "initializing" \| "starting" \| "stopping" \| "off" \| "deleting" \| "migrating" \| "rebuilding" \| "unknown"` | Status of the server. |
| `server.created` | `string` | Creation time (ISO 8601). |
| `server.ipv4` | `string \| null` | Public IPv4 address, or null. |
| `server.ipv6` | `string \| null` | Public IPv6 network (/64), or null. |
| `server.locked` | `boolean` | True while another action runs on the server. |
| `server.labels` | `object` | Labels (untrusted data). |
| `server.protection` | `object` |   |
| `server.protection.delete` | `boolean` | Delete protection. |
| `server.protection.rebuild` | `boolean` | Rebuild protection (servers only). |
| `server.server_type` | `object` | Server type without prices (use pricing_get for prices). |
| `server.server_type.id` | `integer` | ID of the server type. |
| `server.server_type.name` | `string` | Name of the server type. |
| `server.server_type.cores` | `number` | Number of CPU cores. |
| `server.server_type.memory_gb` | `number` | Memory in GB. |
| `server.server_type.disk_gb` | `number` | Disk size in GB. |
| `server.server_type.cpu_type` | `string` | CPU type, e.g. shared or dedicated. |
| `server.server_type.architecture` | `string` | CPU architecture, e.g. x86 or arm. |
| `server.server_type.storage_type` | `string` | Storage type, e.g. local or network. |
| `server.location` | `object` |   |
| `server.location.id` | `integer` | ID of the location. |
| `server.location.name` | `string` | Name of the location, e.g. fsn1. |
| `server.image` | `object \| null` | Image the server was created from, or null. |
| `server.public_net` | `object` | Public network of the server. |
| `server.public_net.ipv4` | `object \| null` | Public IPv4, or null. |
| `server.public_net.ipv6` | `object \| null` | Public IPv6 network, or null. |
| `server.public_net.floating_ips` | `integer[]` | IDs of assigned Floating IPs. |
| `server.public_net.firewalls` | `object[]` | Firewalls applied to the server. |
| `server.public_net.firewalls[].id` | `integer` | ID of the firewall. |
| `server.public_net.firewalls[].status` | `"applied" \| "pending"` | Whether the firewall is applied. |
| `server.private_net` | `object[]` | Private networks the server is attached to. |
| `server.private_net[].network` | `integer` | ID of the network. |
| `server.private_net[].ip` | `string` | Private IP of the server. |
| `server.private_net[].alias_ips` | `string[]` | Additional IPs in the network. |
| `server.iso` | `object \| null` | Attached ISO, or null. |
| `server.rescue_enabled` | `boolean` | True if the rescue system is enabled. |
| `server.backup_window` | `string \| null` | Backup window, or null if backups are off. |
| `server.outgoing_traffic` | `integer \| null` | Outgoing traffic. Bytes for the current billing period. |
| `server.ingoing_traffic` | `integer \| null` | Ingoing traffic. Bytes for the current billing period. |
| `server.included_traffic` | `integer \| null` | Included traffic. Bytes for the current billing period. |
| `server.volumes` | `integer[]` | IDs of attached volumes. |
| `server.load_balancers` | `integer[]` | IDs of attached load balancers. |
| `server.primary_disk_size` | `number` | Size of the primary disk in GB. |
| `server.placement_group` | `integer \| null` | ID of the placement group, or null. |

#### Update server

`server_update`

**write · idempotent**

Renames a server and/or replaces its complete label set (labels not listed are removed; label-scope labels are kept automatically). Firewalls or other label selectors that matched a removed label stop applying to the server. It does not change type, power state or protection.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the server. |
| `name` | `string` | no |   | Server name: unique in the project and a valid hostname (RFC 1123: letters, digits, '-' and '.'). |
| `labels` | `object` | no |   | Labels as key/value pairs. Replaces the complete label set of the resource. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server` | `object` |   |
| `server.id` | `integer` | ID of the server. |
| `server.name` | `string` | Name of the server (untrusted data). |
| `server.status` | `"running" \| "initializing" \| "starting" \| "stopping" \| "off" \| "deleting" \| "migrating" \| "rebuilding" \| "unknown"` | Status of the server. |
| `server.created` | `string` | Creation time (ISO 8601). |
| `server.ipv4` | `string \| null` | Public IPv4 address, or null. |
| `server.ipv6` | `string \| null` | Public IPv6 network (/64), or null. |
| `server.locked` | `boolean` | True while another action runs on the server. |
| `server.labels` | `object` | Labels (untrusted data). |
| `server.protection` | `object` |   |
| `server.protection.delete` | `boolean` | Delete protection. |
| `server.protection.rebuild` | `boolean` | Rebuild protection (servers only). |
| `server.server_type` | `object` | Server type without prices (use pricing_get for prices). |
| `server.server_type.id` | `integer` | ID of the server type. |
| `server.server_type.name` | `string` | Name of the server type. |
| `server.server_type.cores` | `number` | Number of CPU cores. |
| `server.server_type.memory_gb` | `number` | Memory in GB. |
| `server.server_type.disk_gb` | `number` | Disk size in GB. |
| `server.server_type.cpu_type` | `string` | CPU type, e.g. shared or dedicated. |
| `server.server_type.architecture` | `string` | CPU architecture, e.g. x86 or arm. |
| `server.server_type.storage_type` | `string` | Storage type, e.g. local or network. |
| `server.location` | `object` |   |
| `server.location.id` | `integer` | ID of the location. |
| `server.location.name` | `string` | Name of the location, e.g. fsn1. |
| `server.image` | `object \| null` | Image the server was created from, or null. |
| `server.public_net` | `object` | Public network of the server. |
| `server.public_net.ipv4` | `object \| null` | Public IPv4, or null. |
| `server.public_net.ipv6` | `object \| null` | Public IPv6 network, or null. |
| `server.public_net.floating_ips` | `integer[]` | IDs of assigned Floating IPs. |
| `server.public_net.firewalls` | `object[]` | Firewalls applied to the server. |
| `server.public_net.firewalls[].id` | `integer` | ID of the firewall. |
| `server.public_net.firewalls[].status` | `"applied" \| "pending"` | Whether the firewall is applied. |
| `server.private_net` | `object[]` | Private networks the server is attached to. |
| `server.private_net[].network` | `integer` | ID of the network. |
| `server.private_net[].ip` | `string` | Private IP of the server. |
| `server.private_net[].alias_ips` | `string[]` | Additional IPs in the network. |
| `server.iso` | `object \| null` | Attached ISO, or null. |
| `server.rescue_enabled` | `boolean` | True if the rescue system is enabled. |
| `server.backup_window` | `string \| null` | Backup window, or null if backups are off. |
| `server.outgoing_traffic` | `integer \| null` | Outgoing traffic. Bytes for the current billing period. |
| `server.ingoing_traffic` | `integer \| null` | Ingoing traffic. Bytes for the current billing period. |
| `server.included_traffic` | `integer \| null` | Included traffic. Bytes for the current billing period. |
| `server.volumes` | `integer[]` | IDs of attached volumes. |
| `server.load_balancers` | `integer[]` | IDs of attached load balancers. |
| `server.primary_disk_size` | `number` | Size of the primary disk in GB. |
| `server.placement_group` | `integer \| null` | ID of the placement group, or null. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Power server on, shut down or reboot

`server_power`

**write · not idempotent**

Starts a server (on), shuts it down gracefully via ACPI (shutdown) or reboots it gracefully via ACPI (reboot). For shutdown and reboot, action status success only means the signal was sent, not that the server finished; check server_get for status off. For a hard power-off or reset use server_power_force.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the server. |
| `mode` | `"on" \| "shutdown" \| "reboot"` | yes |   | on starts the server; shutdown sends a graceful ACPI shutdown request; reboot sends a graceful ACPI reboot request. The guest OS must react to ACPI for the last two. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server_id` | `integer` | ID of the server. |
| `mode` | `"on" \| "shutdown" \| "reboot"` | Requested power operation. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Force power off or hard reset server

`server_power_force`

**destructive · not idempotent · requires `confirm: true`**

Cuts power to a server (off) or cuts power and starts it again (reset), without letting the operating system stop gracefully; this is like pulling the power cord and can lose unsaved data or corrupt files. Use it only if server_power shutdown or reboot does not work. Requires confirmation.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the server. |
| `mode` | `"off" \| "reset"` | yes |   | off cuts the power and leaves the server stopped; reset cuts the power and starts the server again. Both can lose data. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server_id` | `integer` | ID of the server. |
| `mode` | `"off" \| "reset"` | Requested operation. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Set server protection

`server_protection_set`

**destructive · idempotent · requires `confirm: true`**

Turns delete and rebuild protection of a server on or off together (Hetzner currently requires both to have the same value). With protection on, Hetzner refuses delete and rebuild requests. Protection is never changed by other tools. Every call needs confirmation, also turning protection on, because the same tool can remove it.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the server. |
| `protected` | `boolean` | yes |   | true turns delete and rebuild protection on; false turns both off. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server_id` | `integer` | ID of the server. |
| `protection` | `object` | Requested protection state; applied when the action succeeds. |
| `protection.delete` | `boolean` | Delete protection. |
| `protection.rebuild` | `boolean` | Rebuild protection (servers only). |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Create server

`server_create`

**write · not idempotent · can incur costs · requires `confirm: true`**

Creates a new server from a server type, image and location, injecting the given SSH keys; root passwords are never created or returned, so at least one SSH key is required. The server starts after creation by default and bills from creation until it is deleted; the confirmation preview shows the estimated cost. It returns the preliminary server and the creation actions, not cloud-init user data.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes |   | Server name: unique in the project and a valid hostname (RFC 1123: letters, digits, '-' and '.'). |
| `server_type` | `string` | yes |   | Name or ID of the server type (see catalog_server_types). |
| `image` | `string` | yes |   | Name or ID of the image (see catalog_images). |
| `location` | `string` | yes |   | Name of the location, e.g. 'fsn1' (see catalog_locations). Required because prices differ per location. |
| `ssh_keys` | `string[]` | yes |   | Names of existing SSH keys to inject into the server (see ssh_key_list). At least one is required because root passwords are not supported. |
| `user_data` | `string` | no |   | Cloud-init user data (at most 32 KiB). It is sent to Hetzner but never shown in results, previews or logs. |
| `labels` | `object` | no |   | Labels for the new resource as key/value pairs. Label-scope labels are added automatically; a different value for a scope key is rejected. |
| `public_net` | `object` | no |   | Public network: set enable_ipv4 or enable_ipv6 to false to create the server without that public IP (a new Primary IP costs money; see the preview). At least one must stay enabled. |
| `public_net.enable_ipv4` | `boolean` | no |   | Create a new public IPv4 (default true). |
| `public_net.enable_ipv6` | `boolean` | no |   | Create a new public IPv6 (default true). |
| `start_after_create` | `boolean` | no | `true` | Start the server after creation (default true). |
| `volumes` | `integer (min 1)[]` | no |   | IDs of existing volumes to attach at creation. They must be in the same location. |
| `automount` | `boolean` | no |   | Mount the attached volumes automatically. |
| `firewalls` | `integer (min 1)[]` | no |   | IDs of existing firewalls to apply to the public network interface at creation. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server` | `object` |   |
| `server.id` | `integer` | ID of the server. |
| `server.name` | `string` | Name of the server (untrusted data). |
| `server.status` | `"running" \| "initializing" \| "starting" \| "stopping" \| "off" \| "deleting" \| "migrating" \| "rebuilding" \| "unknown"` | Status of the server. |
| `server.created` | `string` | Creation time (ISO 8601). |
| `server.ipv4` | `string \| null` | Public IPv4 address, or null. |
| `server.ipv6` | `string \| null` | Public IPv6 network (/64), or null. |
| `server.locked` | `boolean` | True while another action runs on the server. |
| `server.labels` | `object` | Labels (untrusted data). |
| `server.protection` | `object` |   |
| `server.protection.delete` | `boolean` | Delete protection. |
| `server.protection.rebuild` | `boolean` | Rebuild protection (servers only). |
| `server.server_type` | `object` | Server type without prices (use pricing_get for prices). |
| `server.server_type.id` | `integer` | ID of the server type. |
| `server.server_type.name` | `string` | Name of the server type. |
| `server.server_type.cores` | `number` | Number of CPU cores. |
| `server.server_type.memory_gb` | `number` | Memory in GB. |
| `server.server_type.disk_gb` | `number` | Disk size in GB. |
| `server.server_type.cpu_type` | `string` | CPU type, e.g. shared or dedicated. |
| `server.server_type.architecture` | `string` | CPU architecture, e.g. x86 or arm. |
| `server.server_type.storage_type` | `string` | Storage type, e.g. local or network. |
| `server.location` | `object` |   |
| `server.location.id` | `integer` | ID of the location. |
| `server.location.name` | `string` | Name of the location, e.g. fsn1. |
| `server.image` | `object \| null` | Image the server was created from, or null. |
| `server.public_net` | `object` | Public network of the server. |
| `server.public_net.ipv4` | `object \| null` | Public IPv4, or null. |
| `server.public_net.ipv6` | `object \| null` | Public IPv6 network, or null. |
| `server.public_net.floating_ips` | `integer[]` | IDs of assigned Floating IPs. |
| `server.public_net.firewalls` | `object[]` | Firewalls applied to the server. |
| `server.public_net.firewalls[].id` | `integer` | ID of the firewall. |
| `server.public_net.firewalls[].status` | `"applied" \| "pending"` | Whether the firewall is applied. |
| `server.private_net` | `object[]` | Private networks the server is attached to. |
| `server.private_net[].network` | `integer` | ID of the network. |
| `server.private_net[].ip` | `string` | Private IP of the server. |
| `server.private_net[].alias_ips` | `string[]` | Additional IPs in the network. |
| `server.iso` | `object \| null` | Attached ISO, or null. |
| `server.rescue_enabled` | `boolean` | True if the rescue system is enabled. |
| `server.backup_window` | `string \| null` | Backup window, or null if backups are off. |
| `server.outgoing_traffic` | `integer \| null` | Outgoing traffic. Bytes for the current billing period. |
| `server.ingoing_traffic` | `integer \| null` | Ingoing traffic. Bytes for the current billing period. |
| `server.included_traffic` | `integer \| null` | Included traffic. Bytes for the current billing period. |
| `server.volumes` | `integer[]` | IDs of attached volumes. |
| `server.load_balancers` | `integer[]` | IDs of attached load balancers. |
| `server.primary_disk_size` | `number` | Size of the primary disk in GB. |
| `server.placement_group` | `integer \| null` | ID of the placement group, or null. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Delete server

`server_delete`

**destructive · idempotent · requires `confirm: true`**

Permanently deletes a server and all data on its disks; this cannot be undone. Attached volumes and floating IPs are detached but not deleted and keep billing; a Primary IP is deleted only if it has auto-deletion enabled. Requires confirmation; the preview shows the cost impact.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the server. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server_id` | `integer` | ID of the server. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Rebuild server

`server_rebuild`

**destructive · idempotent · requires `confirm: true` · gated / not released**

Overwrites a server's disk with an image (a fresh system image, a snapshot or a backup), destroying all data on the server; the server is powered off first. Root passwords are never returned. Requires confirmation.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the server. |
| `image` | `string` | yes |   | Name or ID of the image to rebuild from (see catalog_images). |
| `user_data` | `string` | no |   | Cloud-init user data (at most 32 KiB). If omitted, Hetzner reuses the previous value. It is never shown in results, previews or logs. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server_id` | `integer` | ID of the server. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Change server type

`server_change_type`

**destructive · idempotent · can incur costs · requires `confirm: true`**

Changes the server type (cores, RAM, and optionally disk size) of a server that is powered off; Hetzner copies the disk and starts the server again. With upgrade_disk true the disk is enlarged and the server can never be moved to a smaller type again. Requires confirmation; the preview shows the price change.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the server. |
| `server_type` | `string` | yes |   | Name or ID of the server type to change to (see catalog_server_types). It needs the same storage type and an equal or larger disk. |
| `upgrade_disk` | `boolean` | no | `false` | If true, the disk is enlarged to the new type's size and the server can never be downgraded again. If false (default), only cores and RAM change and a later downgrade stays possible. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server_id` | `integer` | ID of the server. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

## Toolset `info`

#### List orderable server types

`catalog_server_types`

**read-only · idempotent**

Lists Hetzner server types with CPU, memory, disk, architecture and the locations where they can be ordered. By default only types that are currently orderable are returned (not deprecated, not temporarily unavailable); pass 'location' to restrict to one location and get its hourly and monthly price. Does not return traffic prices or deprecated types unless include_unavailable is true; use the returned 'name' as server_type in server_create.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `location` | `string` | no |   | Location name, e.g. 'fsn1' (see catalog_locations). Restricts the result to types orderable there and adds the price for this location. |
| `architecture` | `"x86" \| "arm"` | no |   | CPU architecture filter: 'x86' or 'arm'. Images must match the architecture of the server type. |
| `cpu_type` | `"shared" \| "dedicated"` | no |   | Filter by CPU type: 'shared' (shared vCPU) or 'dedicated'. |
| `name` | `string` | no |   | Exact server type name, e.g. 'cpx22'. Use it to check one specific type. |
| `include_unavailable` | `boolean` | no | `false` | If true, also return deprecated and temporarily unavailable types and mark them per location (fields 'available' and 'deprecation'). Default false: only orderable types. |
| `limit` | `integer (min 1, max 50)` | no | `20` | Maximum number of types returned (default 20, at most 50). 'total_matching' tells how many matched. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` | Matching server types, sorted by name. |
| `items[].id` | `integer` | ID of the server type. |
| `items[].name` | `string` | Name of the server type; use it as server_type in server_create. |
| `items[].description` | `string` | Description of the server type. |
| `items[].category` | `string` | Category of the server type, e.g. 'Shared vCPU'. |
| `items[].cores` | `number` | Number of CPU cores. |
| `items[].memory_gb` | `number` | Memory in GB. |
| `items[].disk_gb` | `number` | Disk size in GB. |
| `items[].cpu_type` | `"shared" \| "dedicated"` | CPU type. |
| `items[].storage_type` | `"local" \| "network"` | Storage type. |
| `items[].architecture` | `"x86" \| "arm"` | CPU architecture. |
| `items[].locations` | `object[]` | Locations where the type can be ordered. |
| `items[].locations[].name` | `string` | Location name, e.g. fsn1. |
| `items[].locations[].recommended` | `boolean` | Whether Hetzner recommends this location for the type. |
| `items[].locations[].available` | `boolean` | Whether the type is currently available there (only with include_unavailable). |
| `items[].locations[].deprecation` | `object \| null` | Deprecation of the type in this location, null if none (only with include_unavailable). |
| `items[].price` | `object` | Price in the requested location (only if 'location' is given). |
| `items[].price.hourly` | `object` | Hourly price in the requested location. |
| `items[].price.hourly.net` | `string` | Net price as exact decimal string. |
| `items[].price.hourly.gross` | `string` | Gross price as exact decimal string. |
| `items[].price.hourly.currency` | `string` | Currency as reported by Hetzner, e.g. EUR. |
| `items[].price.monthly` | `object` | Monthly price in the requested location. |
| `items[].price.monthly.net` | `string` | Net price as exact decimal string. |
| `items[].price.monthly.gross` | `string` | Gross price as exact decimal string. |
| `items[].price.monthly.currency` | `string` | Currency as reported by Hetzner, e.g. EUR. |
| `total_matching` | `integer` | Number of types that matched, before limit. |

#### List images

`catalog_images`

**read-only · idempotent**

Lists images usable for servers. By default only current system images (operating systems) that are available and not deprecated are returned; set 'type' to include snapshots, backups or apps. Does not return deprecated images unless include_deprecated is true; use 'name' (system images) or 'id' (snapshots, which have no name) as image in server_create.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | `"system" \| "app" \| "snapshot" \| "backup"[]` | no | `["system"]` | Image types to list. Default ['system'] (operating systems). Add 'snapshot' or 'backup' for your own images. |
| `architecture` | `"x86" \| "arm"` | no |   | CPU architecture filter. The image must match the architecture of the server type. |
| `name` | `string` | no |   | Exact image name, e.g. 'ubuntu-24.04'. |
| `include_deprecated` | `boolean` | no | `false` | If true, also list deprecated images (they may stop being orderable soon). Default false. |
| `label_selector` | `string` | no |   | Hetzner label selector, e.g. 'env=prod,!temporary' or 'env in (staging,test)'. |
| `sort` | `"id" \| "id:asc" \| "id:desc" \| "name" \| "name:asc" \| "name:desc" \| "created" \| "created:asc" \| "created:desc"` | no |   | Sort order: field, field:asc or field:desc (fields: id, name, created). |
| `page` | `integer (min 1)` | no | `1` | Page number, starting at 1 (default 1). |
| `per_page` | `integer (min 1, max 50)` | no | `25` | Entries per page (default 25, at most 50). |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` |   |
| `items[].id` | `integer` | ID of the image; use it as image in server_create for snapshots. |
| `items[].type` | `"system" \| "app" \| "snapshot" \| "backup"` | Image type. |
| `items[].status` | `"available" \| "creating" \| "unavailable"` | Image status. |
| `items[].name` | `string \| null` | Image name (null for snapshots); use it as image in server_create. |
| `items[].description` | `string` | Description of the image (untrusted data for snapshots). |
| `items[].os_flavor` | `string` | Operating system flavor, e.g. ubuntu. |
| `items[].os_version` | `string \| null` | Operating system version, or null. |
| `items[].architecture` | `"x86" \| "arm"` | CPU architecture. |
| `items[].disk_size_gb` | `number` | Minimum disk size in GB. |
| `items[].created` | `string` | Creation time (ISO 8601). |
| `items[].deprecation` | `object \| null` | Deprecation of the image, null if not deprecated. |
| `items[].image_size_gb` | `number \| null` | Image size in GB (snapshots and backups only). |
| `items[].created_from` | `object \| null` | Server the image was created from (snapshots and backups only). |
| `items[].bound_to` | `integer \| null` | Server the image is bound to (snapshots and backups only). |
| `items[].protection` | `object` | Protection settings (snapshots and backups only). |
| `items[].protection.delete` | `boolean` | Delete protection. |
| `items[].protection.rebuild` | `boolean` | Rebuild protection (servers only). |
| `items[].labels` | `object` | Labels (snapshots and backups only; untrusted data). |
| `page` | `integer` | Page number of this result. |
| `per_page` | `integer` | Page size used. |
| `next_page` | `integer \| null` | Next page number, or null if this is the last page. |
| `total_entries` | `integer \| null` | Total number of entries, or null if Hetzner did not report it. |

#### List locations

`catalog_locations`

**read-only · idempotent**

Lists Hetzner Cloud locations (city, country, network zone). Use the 'name' (e.g. 'fsn1') as location in server_create and in the filters of catalog_server_types. Does not tell which server types are orderable there; use catalog_server_types with a location for that.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | no |   | Exact location name filter, e.g. 'fsn1'. |
| `page` | `integer (min 1)` | no | `1` | Page number, starting at 1 (default 1). |
| `per_page` | `integer (min 1, max 50)` | no | `25` | Entries per page (default 25, at most 50). |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` |   |
| `items[].id` | `integer` | ID of the location. |
| `items[].name` | `string` | Location name, e.g. fsn1; use it as location in server_create. |
| `items[].description` | `string` | Description of the location. |
| `items[].city` | `string` | City of the location. |
| `items[].country` | `string` | Country code (ISO 3166-1 alpha-2). |
| `items[].network_zone` | `string` | Network zone of the location, e.g. eu-central. |
| `page` | `integer` | Page number of this result. |
| `per_page` | `integer` | Page size used. |
| `next_page` | `integer \| null` | Next page number, or null if this is the last page. |
| `total_entries` | `integer \| null` | Total number of entries, or null if Hetzner did not report it. |

#### Get pricing

`pricing_get`

**read-only · idempotent**

Returns the account's Hetzner Cloud prices as delivered by Hetzner: currency, VAT rate, volume and snapshot price per GB and month, the backup surcharge, and (only if 'server_type' is given) that server type's prices in every location. Prices are net and gross, with the currency from the API. Does not list all server types; use catalog_server_types for that.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `server_type` | `string` | no |   | Exact server type name, e.g. 'cpx22'. If set, the result includes this type's hourly and monthly price for every location. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `currency` | `string` | Currency of all prices, as reported by Hetzner. |
| `vat_rate` | `string` | VAT rate in percent as decimal string. |
| `volume_gb_month` | `object` | Volume price per GB and month. |
| `volume_gb_month.net` | `string` | Net price as exact decimal string. |
| `volume_gb_month.gross` | `string` | Gross price as exact decimal string. |
| `volume_gb_month.currency` | `string` | Currency as reported by Hetzner, e.g. EUR. |
| `snapshot_gb_month` | `object` | Snapshot price per GB and month. |
| `snapshot_gb_month.net` | `string` | Net price as exact decimal string. |
| `snapshot_gb_month.gross` | `string` | Gross price as exact decimal string. |
| `snapshot_gb_month.currency` | `string` | Currency as reported by Hetzner, e.g. EUR. |
| `backup_surcharge_percent` | `string` | Percentage added to the monthly server price when backups are enabled. |
| `server_type` | `object` | Prices of the requested server type (only if found). |
| `server_type.name` | `string` | Server type name. |
| `server_type.prices` | `object[]` | Prices per location. |
| `server_type.prices[].location` | `string` | Location name, e.g. fsn1. |
| `server_type.prices[].hourly` | `object` | Hourly price in this location. |
| `server_type.prices[].hourly.net` | `string` | Net price as exact decimal string. |
| `server_type.prices[].hourly.gross` | `string` | Gross price as exact decimal string. |
| `server_type.prices[].hourly.currency` | `string` | Currency as reported by Hetzner, e.g. EUR. |
| `server_type.prices[].monthly` | `object` | Monthly price in this location. |
| `server_type.prices[].monthly.net` | `string` | Net price as exact decimal string. |
| `server_type.prices[].monthly.gross` | `string` | Gross price as exact decimal string. |
| `server_type.prices[].monthly.currency` | `string` | Currency as reported by Hetzner, e.g. EUR. |

## Toolset `actions`

#### Get an action

`action_get`

**read-only · idempotent**

Returns the current state of one Hetzner action (status, progress, error) by ID. Use it to follow up when a write tool reported status 'running'; reading a failed action is not an error. Does not wait: call it again later instead of polling quickly.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the action. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `action` | `object` | Current state of the action. |
| `action.id` | `integer` | ID of the Hetzner action. |
| `action.command` | `string` | Command the action performs, e.g. start_server. |
| `action.status` | `"running" \| "success" \| "error"` | Status of the action. |
| `action.progress` | `integer` | Progress in percent (0-100). |
| `action.started` | `string` | Start time (ISO 8601). |
| `action.finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `action.error` | `object \| null` | Error of a failed action, or null. |
| `action.resources` | `object[]` | Resources the action affects. |
| `action.resources[].id` | `integer` | ID of the resource. |
| `action.resources[].type` | `string` | Type of the resource, e.g. server. |

#### List actions of a resource

`action_list`

**read-only · idempotent**

Lists the Hetzner actions (power, rebuild, attach, snapshot and similar operations) of one server, volume, firewall or image, newest first by default. Use it to see what is running on a resource, for example after a 'locked' error. Does not list actions across the whole project.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `resource_type` | `"server" \| "volume" \| "firewall" \| "image"` | yes |   | Type of the resource whose actions to list. |
| `resource_id` | `integer (min 1)` | yes |   | ID of the resource. |
| `status` | `"running" \| "success" \| "error"[]` | no |   | Only actions with one of these statuses, e.g. ['running']. |
| `sort` | `"id" \| "id:asc" \| "id:desc" \| "command" \| "command:asc" \| "command:desc" \| "status" \| "status:asc" \| "status:desc" \| "started" \| "started:asc" \| "started:desc" \| "finished" \| "finished:asc" \| "finished:desc"` | no |   | Sort order: field, field:asc or field:desc (fields: id, command, status, started, finished). |
| `page` | `integer (min 1)` | no | `1` | Page number, starting at 1 (default 1). |
| `per_page` | `integer (min 1, max 50)` | no | `25` | Entries per page (default 25, at most 50). |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` |   |
| `items[].id` | `integer` | ID of the Hetzner action. |
| `items[].command` | `string` | Command the action performs, e.g. start_server. |
| `items[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `items[].progress` | `integer` | Progress in percent (0-100). |
| `items[].started` | `string` | Start time (ISO 8601). |
| `items[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `items[].error` | `object \| null` | Error of a failed action, or null. |
| `items[].resources` | `object[]` | Resources the action affects. |
| `items[].resources[].id` | `integer` | ID of the resource. |
| `items[].resources[].type` | `string` | Type of the resource, e.g. server. |
| `page` | `integer` | Page number of this result. |
| `per_page` | `integer` | Page size used. |
| `next_page` | `integer \| null` | Next page number, or null if this is the last page. |
| `total_entries` | `integer \| null` | Total number of entries, or null if Hetzner did not report it. |

## Toolset `ssh_keys`

#### List SSH keys

`ssh_key_list`

**read-only · idempotent**

Lists the SSH keys stored in the Hetzner project with ID, name, fingerprint and labels. Use the 'name' values as ssh_keys in server_create. Does not return the public key text; use ssh_key_get for that.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | no |   | Exact SSH key name filter. |
| `fingerprint` | `string` | no |   | Exact MD5 fingerprint filter, e.g. 'b7:2f:30:a0:2f:6c:58:6c:21:04:58:61:ba:06:3b:2f'. |
| `label_selector` | `string` | no |   | Hetzner label selector, e.g. 'env=prod,!temporary' or 'env in (staging,test)'. |
| `sort` | `"id" \| "id:asc" \| "id:desc" \| "name" \| "name:asc" \| "name:desc"` | no |   | Sort order: field, field:asc or field:desc (fields: id, name). |
| `page` | `integer (min 1)` | no | `1` | Page number, starting at 1 (default 1). |
| `per_page` | `integer (min 1, max 50)` | no | `25` | Entries per page (default 25, at most 50). |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` |   |
| `items[].id` | `integer` | ID of the SSH key. |
| `items[].name` | `string` | Name of the SSH key (untrusted data). Use it in ssh_keys of server_create. |
| `items[].fingerprint` | `string` | MD5 fingerprint of the public key, e.g. 'b7:2f:…'. Use it to recognise a key you hold locally (ssh-keygen -l -E md5 -f key.pub). |
| `items[].labels` | `object` | Labels (untrusted data). |
| `items[].created` | `string` | Creation time (ISO 8601). |
| `page` | `integer` | Page number of this result. |
| `per_page` | `integer` | Page size used. |
| `next_page` | `integer \| null` | Next page number, or null if this is the last page. |
| `total_entries` | `integer \| null` | Total number of entries, or null if Hetzner did not report it. |

#### Get an SSH key

`ssh_key_get`

**read-only · idempotent**

Returns one SSH key by ID, including its public key text and fingerprint. Does not return private keys; Hetzner never stores them.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the SSH key. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `ssh_key` | `object` |   |
| `ssh_key.id` | `integer` | ID of the SSH key. |
| `ssh_key.name` | `string` | Name of the SSH key (untrusted data). Use it in ssh_keys of server_create. |
| `ssh_key.fingerprint` | `string` | MD5 fingerprint of the public key, e.g. 'b7:2f:…'. Use it to recognise a key you hold locally (ssh-keygen -l -E md5 -f key.pub). |
| `ssh_key.labels` | `object` | Labels (untrusted data). |
| `ssh_key.created` | `string` | Creation time (ISO 8601). |
| `ssh_key.public_key` | `string` | The public key text (not a secret). |

#### Create an SSH key

`ssh_key_create`

**write · not idempotent**

Adds a public SSH key to the Hetzner project so it can be used when creating servers. Accepts only a public key line (e.g. 'ssh-ed25519 AAAA… comment'), never a private key; Hetzner rejects duplicates by fingerprint. Creating a key is free and reversible with ssh_key_delete.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes |   | Name of the SSH key. Must be unique in the project. |
| `public_key` | `string` | yes |   | The public key as one line: '<type> <base64> [comment]', e.g. 'ssh-ed25519 AAAAC3… me@host'. Contents of a .pub file. Never a private key. |
| `labels` | `object` | no |   | Labels for the new resource as key/value pairs. Label-scope labels are added automatically; a different value for a scope key is rejected. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `ssh_key` | `object` |   |
| `ssh_key.id` | `integer` | ID of the SSH key. |
| `ssh_key.name` | `string` | Name of the SSH key (untrusted data). Use it in ssh_keys of server_create. |
| `ssh_key.fingerprint` | `string` | MD5 fingerprint of the public key, e.g. 'b7:2f:…'. Use it to recognise a key you hold locally (ssh-keygen -l -E md5 -f key.pub). |
| `ssh_key.labels` | `object` | Labels (untrusted data). |
| `ssh_key.created` | `string` | Creation time (ISO 8601). |
| `ssh_key.public_key` | `string` | The public key text (not a secret). |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Update an SSH key

`ssh_key_update`

**write · idempotent**

Renames an SSH key and/or replaces its labels. The labels you send replace the complete label set, so read the current labels with ssh_key_get first. The public key itself cannot be changed; create a new key instead.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the SSH key. |
| `name` | `string` | no |   | New name of the SSH key. |
| `labels` | `object` | no |   | Labels as key/value pairs. Replaces the complete label set of the resource. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `ssh_key` | `object` |   |
| `ssh_key.id` | `integer` | ID of the SSH key. |
| `ssh_key.name` | `string` | Name of the SSH key (untrusted data). Use it in ssh_keys of server_create. |
| `ssh_key.fingerprint` | `string` | MD5 fingerprint of the public key, e.g. 'b7:2f:…'. Use it to recognise a key you hold locally (ssh-keygen -l -E md5 -f key.pub). |
| `ssh_key.labels` | `object` | Labels (untrusted data). |
| `ssh_key.created` | `string` | Creation time (ISO 8601). |
| `ssh_key.public_key` | `string` | The public key text (not a secret). |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Delete an SSH key

`ssh_key_delete`

**destructive · idempotent · requires `confirm: true`**

Deletes an SSH key from the Hetzner project; it can no longer be selected when creating servers. The key can be added again with ssh_key_create if the public key is at hand. Requires user approval and confirm: true.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the SSH key. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the deleted SSH key. |
| `deleted` | `boolean` | True once Hetzner confirmed the deletion. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

## Toolset `firewalls`

#### List firewalls

`firewall_list`

**read-only · idempotent**

Lists firewalls of the project with their ID, name, labels, and rule and target counts. Does not return the rules themselves; use firewall_get for those. Supports filtering by name or label selector and paging.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | no |   | Only firewalls with exactly this name. |
| `label_selector` | `string` | no |   | Hetzner label selector, e.g. 'env=prod,!temporary' or 'env in (staging,test)'. |
| `sort` | `"id" \| "id:asc" \| "id:desc" \| "name" \| "name:asc" \| "name:desc" \| "created" \| "created:asc" \| "created:desc"` | no |   | Sort order: field, field:asc or field:desc (fields: id, name, created). |
| `page` | `integer (min 1)` | no | `1` | Page number, starting at 1 (default 1). |
| `per_page` | `integer (min 1, max 50)` | no | `25` | Entries per page (default 25, at most 50). |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` |   |
| `items[].id` | `integer` | ID of the firewall. |
| `items[].name` | `string` | Name of the firewall (untrusted data). |
| `items[].labels` | `object` | Labels (untrusted data). |
| `items[].created` | `string` | Creation time (ISO 8601). |
| `items[].rule_count` | `integer` | Number of rules. |
| `items[].applied_to_count` | `integer` | Number of targets (entries, not servers) the firewall is applied to. |
| `page` | `integer` | Page number of this result. |
| `per_page` | `integer` | Page size used. |
| `next_page` | `integer \| null` | Next page number, or null if this is the last page. |
| `total_entries` | `integer \| null` | Total number of entries, or null if Hetzner did not report it. |

#### Get a firewall

`firewall_get`

**read-only · idempotent**

Returns one firewall with all its rules and the resources it is applied to. For label-selector targets it lists the servers the selector currently matches. Does not return the firewall's action history.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the firewall. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the firewall. |
| `name` | `string` | Name of the firewall (untrusted data). |
| `labels` | `object` | Labels (untrusted data). |
| `created` | `string` | Creation time (ISO 8601). |
| `rules` | `object[]` | Rules of the firewall. |
| `rules[].direction` | `"in" \| "out"` | Traffic direction of the rule. |
| `rules[].protocol` | `"tcp" \| "udp" \| "icmp" \| "esp" \| "gre"` | Network protocol of the rule. |
| `rules[].port` | `string \| null` | Port or port range, or null (icmp, esp, gre, all ports). |
| `rules[].source_ips` | `string[]` | Allowed source addresses (CIDR) for direction 'in'. |
| `rules[].destination_ips` | `string[]` | Allowed destination addresses (CIDR) for direction 'out'. |
| `rules[].description` | `string \| null` | Description of the rule (untrusted data), or null. |
| `applied_to` | `object[]` | Targets the firewall is applied to. |
| `applied_to[].type` | `"server" \| "label_selector"` | Kind of target. |
| `applied_to[].server_id` | `integer \| null` | Server ID when type is 'server', else null. |
| `applied_to[].label_selector` | `string \| null` | Selector (untrusted data) when type is 'label_selector', else null. |
| `applied_to[].resource_server_ids` | `integer[]` | IDs of the servers the firewall is applied to through this target. |

#### Create a firewall

`firewall_create`

**write · not idempotent**

Creates a firewall with optional rules. The firewall protects nothing until it is applied to servers with firewall_apply_to_resources. Applying is a separate step on purpose; the new firewall inherits the configured label scope.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes |   | Name of the firewall: unique in the project, 1 to 128 characters. |
| `rules` | `object[]` | no |   | Firewall rules (at most 50). Omit for a firewall without rules. |
| `rules[].direction` | `"in" \| "out"` | yes |   | Traffic direction the rule applies to. Use source_ips for 'in' and destination_ips for 'out'. |
| `rules[].protocol` | `"tcp" \| "udp" \| "icmp" \| "esp" \| "gre"` | yes |   | Network protocol of the rule. |
| `rules[].port` | `string` | no |   | Port or port range ('80' or '1024-5000'). Only for tcp and udp. |
| `rules[].source_ips` | `string[]` | no |   | Allowed source addresses in CIDR notation (at most 100), for direction 'in'. Use 0.0.0.0/0 and ::/0 for any address. |
| `rules[].destination_ips` | `string[]` | no |   | Allowed destination addresses in CIDR notation (at most 100), for direction 'out'. Use 0.0.0.0/0 and ::/0 for any address. |
| `rules[].description` | `string \| null` | no |   | Free-text description of the rule (at most 255 characters). |
| `labels` | `object` | no |   | Labels for the new resource as key/value pairs. Label-scope labels are added automatically; a different value for a scope key is rejected. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the firewall. |
| `name` | `string` | Name of the firewall (untrusted data). |
| `labels` | `object` | Labels (untrusted data). |
| `created` | `string` | Creation time (ISO 8601). |
| `rules` | `object[]` | Rules of the firewall. |
| `rules[].direction` | `"in" \| "out"` | Traffic direction of the rule. |
| `rules[].protocol` | `"tcp" \| "udp" \| "icmp" \| "esp" \| "gre"` | Network protocol of the rule. |
| `rules[].port` | `string \| null` | Port or port range, or null (icmp, esp, gre, all ports). |
| `rules[].source_ips` | `string[]` | Allowed source addresses (CIDR) for direction 'in'. |
| `rules[].destination_ips` | `string[]` | Allowed destination addresses (CIDR) for direction 'out'. |
| `rules[].description` | `string \| null` | Description of the rule (untrusted data), or null. |
| `applied_to` | `object[]` | Targets the firewall is applied to. |
| `applied_to[].type` | `"server" \| "label_selector"` | Kind of target. |
| `applied_to[].server_id` | `integer \| null` | Server ID when type is 'server', else null. |
| `applied_to[].label_selector` | `string \| null` | Selector (untrusted data) when type is 'label_selector', else null. |
| `applied_to[].resource_server_ids` | `integer[]` | IDs of the servers the firewall is applied to through this target. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Update a firewall's name or labels

`firewall_update`

**write · idempotent**

Renames a firewall and/or replaces its complete label set. It does not change rules or targets; use firewall_set_rules or firewall_apply_to_resources for those. Labels you send replace all existing labels, so include the ones to keep.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the firewall. |
| `name` | `string` | no |   | New name of the firewall (unique in the project, 1 to 128 characters). |
| `labels` | `object` | no |   | Labels as key/value pairs. Replaces the complete label set of the resource. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the firewall. |
| `name` | `string` | Name of the firewall (untrusted data). |
| `labels` | `object` | Labels (untrusted data). |
| `created` | `string` | Creation time (ISO 8601). |
| `rules` | `object[]` | Rules of the firewall. |
| `rules[].direction` | `"in" \| "out"` | Traffic direction of the rule. |
| `rules[].protocol` | `"tcp" \| "udp" \| "icmp" \| "esp" \| "gre"` | Network protocol of the rule. |
| `rules[].port` | `string \| null` | Port or port range, or null (icmp, esp, gre, all ports). |
| `rules[].source_ips` | `string[]` | Allowed source addresses (CIDR) for direction 'in'. |
| `rules[].destination_ips` | `string[]` | Allowed destination addresses (CIDR) for direction 'out'. |
| `rules[].description` | `string \| null` | Description of the rule (untrusted data), or null. |
| `applied_to` | `object[]` | Targets the firewall is applied to. |
| `applied_to[].type` | `"server" \| "label_selector"` | Kind of target. |
| `applied_to[].server_id` | `integer \| null` | Server ID when type is 'server', else null. |
| `applied_to[].label_selector` | `string \| null` | Selector (untrusted data) when type is 'label_selector', else null. |
| `applied_to[].resource_server_ids` | `integer[]` | IDs of the servers the firewall is applied to through this target. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Replace all rules of a firewall

`firewall_set_rules`

**destructive · idempotent · requires `confirm: true`**

Replaces ALL rules of a firewall with the given list; existing rules are discarded, and an empty list removes every rule. The change takes effect on every server the firewall is applied to and can lock you out of them (for example by dropping SSH). Returns the triggered actions, not the new rule set.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the firewall. |
| `rules` | `object[]` | yes |   | The complete new rule list (at most 50). It replaces all existing rules; [] removes all rules. |
| `rules[].direction` | `"in" \| "out"` | yes |   | Traffic direction the rule applies to. Use source_ips for 'in' and destination_ips for 'out'. |
| `rules[].protocol` | `"tcp" \| "udp" \| "icmp" \| "esp" \| "gre"` | yes |   | Network protocol of the rule. |
| `rules[].port` | `string` | no |   | Port or port range ('80' or '1024-5000'). Only for tcp and udp. |
| `rules[].source_ips` | `string[]` | no |   | Allowed source addresses in CIDR notation (at most 100), for direction 'in'. Use 0.0.0.0/0 and ::/0 for any address. |
| `rules[].destination_ips` | `string[]` | no |   | Allowed destination addresses in CIDR notation (at most 100), for direction 'out'. Use 0.0.0.0/0 and ::/0 for any address. |
| `rules[].description` | `string \| null` | no |   | Free-text description of the rule (at most 255 characters). |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the firewall. |
| `rule_count` | `integer` | Number of rules sent. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Apply a firewall to servers

`firewall_apply_to_resources`

**write · not idempotent**

Adds servers and/or label selectors as targets of a firewall, extending the existing targets. The firewall's rules start to filter traffic on those servers as soon as the actions finish, which can cut off connections that the rules do not allow. A server can have at most 5 firewalls, including those applied through label selectors.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the firewall. |
| `server_ids` | `integer (min 1)[]` | no |   | IDs of servers to include. Servers need a public network interface. |
| `label_selectors` | `string[]` | no |   | Label selectors to include; every server matching one is affected, now and in the future. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the firewall. |
| `server_count` | `integer` | Number of servers named in the call. |
| `label_selector_count` | `integer` | Number of label selectors named in the call. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Remove a firewall from servers

`firewall_remove_from_resources`

**write · not idempotent**

Removes servers and/or label-selector targets from a firewall. Servers without any firewall are no longer filtered, which may expose services that were blocked. A server that is covered through a label selector cannot be removed directly; remove the selector target instead.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the firewall. |
| `server_ids` | `integer (min 1)[]` | no |   | IDs of servers to include. Servers need a public network interface. |
| `label_selectors` | `string[]` | no |   | Label selectors to include; every server matching one is affected, now and in the future. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the firewall. |
| `server_count` | `integer` | Number of servers named in the call. |
| `label_selector_count` | `integer` | Number of label selectors named in the call. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Delete a firewall

`firewall_delete`

**destructive · idempotent · requires `confirm: true`**

Permanently deletes a firewall and its rules. Fails while the firewall is still applied to resources; remove it from all of them first. Servers it protected are no longer filtered by it.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the firewall. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the deleted firewall. |
| `deleted` | `boolean` | True once Hetzner confirmed the deletion. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

## Toolset `storage`

#### List volumes

`volume_list`

**read-only · idempotent**

Lists block-storage volumes with size, status, location, the server each is attached to, labels and protection. Does not return the content or mount state of a volume. Supports filtering by name, status or label selector and paging.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | no |   | Only volumes with exactly this name. |
| `status` | `"available" \| "creating"` | no |   | Only volumes in this status. |
| `label_selector` | `string` | no |   | Hetzner label selector, e.g. 'env=prod,!temporary' or 'env in (staging,test)'. |
| `sort` | `"id" \| "id:asc" \| "id:desc" \| "name" \| "name:asc" \| "name:desc" \| "created" \| "created:asc" \| "created:desc"` | no |   | Sort order: field, field:asc or field:desc (fields: id, name, created). |
| `page` | `integer (min 1)` | no | `1` | Page number, starting at 1 (default 1). |
| `per_page` | `integer (min 1, max 50)` | no | `25` | Entries per page (default 25, at most 50). |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` |   |
| `items[].id` | `integer` | ID of the volume. |
| `items[].name` | `string` | Name of the volume (untrusted data). |
| `items[].size` | `integer` | Size in GB. |
| `items[].status` | `"available" \| "creating"` | Status of the volume. |
| `items[].format` | `string \| null` | File system created on the volume, or null. |
| `items[].linux_device` | `string` | Device path of the volume inside an attached server. |
| `items[].location` | `object` | Location of the volume. |
| `items[].location.id` | `integer` | ID of the location. |
| `items[].location.name` | `string` | Name of the location, e.g. fsn1. |
| `items[].assignee` | `object \| null` | Resource the volume is attached to, or null if it is detached. |
| `items[].protection` | `object` | Protection of the volume. |
| `items[].protection.delete` | `boolean` | Delete protection. |
| `items[].labels` | `object` | Labels (untrusted data). |
| `items[].created` | `string` | Creation time (ISO 8601). |
| `page` | `integer` | Page number of this result. |
| `per_page` | `integer` | Page size used. |
| `next_page` | `integer \| null` | Next page number, or null if this is the last page. |
| `total_entries` | `integer \| null` | Total number of entries, or null if Hetzner did not report it. |

#### Get a volume

`volume_get`

**read-only · idempotent**

Returns one volume with size, status, location, attachment, device path, labels and delete protection. Does not return volume content or its action history.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the volume. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the volume. |
| `name` | `string` | Name of the volume (untrusted data). |
| `size` | `integer` | Size in GB. |
| `status` | `"available" \| "creating"` | Status of the volume. |
| `format` | `string \| null` | File system created on the volume, or null. |
| `linux_device` | `string` | Device path of the volume inside an attached server. |
| `location` | `object` | Location of the volume. |
| `location.id` | `integer` | ID of the location. |
| `location.name` | `string` | Name of the location, e.g. fsn1. |
| `assignee` | `object \| null` | Resource the volume is attached to, or null if it is detached. |
| `protection` | `object` | Protection of the volume. |
| `protection.delete` | `boolean` | Delete protection. |
| `labels` | `object` | Labels (untrusted data). |
| `created` | `string` | Creation time (ISO 8601). |

#### Create a volume

`volume_create`

**write · not idempotent · can incur costs · requires `confirm: true`**

Creates a block-storage volume of 10 to 10240 GB, optionally attached to a server at creation. The volume is billed per GB and month from creation until it is deleted, even when unattached; it cannot be shrunk later. Provide exactly one of location or server_id; the volume is created in the server's location when server_id is given. Requires confirmation; the preview shows the estimated cost.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | yes |   | Name of the volume: unique in the project, at most 64 characters; letters, digits, '-', '_' and '.', starting and ending with a letter or digit. |
| `size` | `integer (min 10, max 10240)` | yes |   | Size in GB (10 to 10240). Cannot be reduced later. |
| `location` | `string` | no |   | Name of the location to create the volume in, e.g. 'fsn1' (see catalog_locations). Omit when server_id is given. |
| `server_id` | `integer (min 1)` | no |   | ID of a server to attach the volume to after creation. The volume is created in that server's location. |
| `automount` | `boolean` | no |   | Mount the volume automatically after attaching. Only together with server_id. |
| `format` | `"xfs" \| "ext4"` | no |   | File system to create on the volume. Omit for an unformatted volume. |
| `labels` | `object` | no |   | Labels for the new resource as key/value pairs. Label-scope labels are added automatically; a different value for a scope key is rejected. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `volume` | `object` | The new volume. |
| `volume.id` | `integer` | ID of the volume. |
| `volume.name` | `string` | Name of the volume (untrusted data). |
| `volume.size` | `integer` | Size in GB. |
| `volume.status` | `"available" \| "creating"` | Status of the volume. |
| `volume.format` | `string \| null` | File system created on the volume, or null. |
| `volume.linux_device` | `string` | Device path of the volume inside an attached server. |
| `volume.location` | `object` | Location of the volume. |
| `volume.location.id` | `integer` | ID of the location. |
| `volume.location.name` | `string` | Name of the location, e.g. fsn1. |
| `volume.assignee` | `object \| null` | Resource the volume is attached to, or null if it is detached. |
| `volume.protection` | `object` | Protection of the volume. |
| `volume.protection.delete` | `boolean` | Delete protection. |
| `volume.labels` | `object` | Labels (untrusted data). |
| `volume.created` | `string` | Creation time (ISO 8601). |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Attach a volume to a server

`volume_attach`

**write · not idempotent**

Attaches a volume to a server in the same location. Does not mount or format the volume unless automount is set. Fails if the volume is already attached or the server is in another location.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the volume. |
| `server_id` | `integer (min 1)` | yes |   | ID of the server to attach the volume to. It must be in the same location as the volume. |
| `automount` | `boolean` | no |   | Mount the volume automatically after attaching. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the volume. |
| `server_id` | `integer` | ID of the server the volume is attached to. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Detach a volume

`volume_detach`

**write · not idempotent**

Detaches a volume from the server it is attached to. The volume and its data are kept and can be attached again later. Does not unmount the volume inside the server.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the volume. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the volume. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Resize a volume

`volume_resize`

**write · not idempotent · can incur costs · requires `confirm: true`**

Increases the size of a volume to the given number of GB. Shrinking is not possible, so this cannot be undone, and the larger size is billed per GB and month. Does not grow the file system inside the server. Requires confirmation; the preview shows the price change.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the volume. |
| `size` | `integer (min 10, max 10240)` | yes |   | New size in GB (at most 10240). Must be greater than the current size; shrinking is not possible. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the volume. |
| `size` | `integer` | Requested size in GB. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Update a volume's name or labels

`volume_update`

**write · idempotent**

Renames a volume and/or replaces its complete label set. Does not change size, attachment or protection. Labels you send replace all existing labels, so include the ones to keep.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the volume. |
| `name` | `string` | no |   | New name of the volume (unique in the project, at most 64 characters). |
| `labels` | `object` | no |   | Labels as key/value pairs. Replaces the complete label set of the resource. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the volume. |
| `name` | `string` | Name of the volume (untrusted data). |
| `size` | `integer` | Size in GB. |
| `status` | `"available" \| "creating"` | Status of the volume. |
| `format` | `string \| null` | File system created on the volume, or null. |
| `linux_device` | `string` | Device path of the volume inside an attached server. |
| `location` | `object` | Location of the volume. |
| `location.id` | `integer` | ID of the location. |
| `location.name` | `string` | Name of the location, e.g. fsn1. |
| `assignee` | `object \| null` | Resource the volume is attached to, or null if it is detached. |
| `protection` | `object` | Protection of the volume. |
| `protection.delete` | `boolean` | Delete protection. |
| `labels` | `object` | Labels (untrusted data). |
| `created` | `string` | Creation time (ISO 8601). |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Delete a volume

`volume_delete`

**destructive · idempotent · requires `confirm: true`**

Permanently deletes a volume; all data on it is irreversibly destroyed. The volume must be detached from its server and must not have delete protection enabled. Snapshots of the server do not contain volume data.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the volume. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the deleted volume. |
| `deleted` | `boolean` | True once Hetzner confirmed the deletion. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Set volume delete protection

`volume_protection_set`

**destructive · idempotent · requires `confirm: true`**

Turns delete protection of a volume on or off. With protection on, Hetzner refuses to delete the volume. Protection is never changed by other tools. Every call needs confirmation, also turning protection on, because the same tool can remove it.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the volume. |
| `protected` | `boolean` | yes |   | true turns delete protection on; false turns it off. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the volume. |
| `protection` | `object` | Requested protection state; applied when the action succeeds. |
| `protection.delete` | `boolean` | Delete protection. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Create a snapshot of a server

`snapshot_create`

**write · not idempotent · can incur costs · requires `confirm: true`**

Creates a snapshot image of a server's disk. Snapshots survive deletion of the server and are billed per GB and month until deleted. For a consistent result shut the server down first; a running server may yield an unreadable image. Requires confirmation; the preview shows the price per GB.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `server_id` | `integer (min 1)` | yes |   | ID of the server. |
| `description` | `string` | no |   | Description of the snapshot. Generated by Hetzner if omitted. |
| `labels` | `object` | no |   | Labels for the new resource as key/value pairs. Label-scope labels are added automatically; a different value for a scope key is rejected. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `image` | `object` | The new snapshot image. |
| `image.id` | `integer` | ID of the image. |
| `image.type` | `"snapshot" \| "backup" \| "system" \| "app"` | Type of the image. |
| `image.status` | `"available" \| "creating" \| "unavailable"` | Status of the image. |
| `image.name` | `string \| null` | Name of the image (untrusted data), or null. |
| `image.description` | `string` | Description of the image (untrusted data). |
| `image.created` | `string` | Creation time (ISO 8601). |
| `image.image_size` | `number \| null` | Size in GB in storage; billing basis of snapshots. Null while unknown. |
| `image.disk_size` | `number` | Size in GB of the disk the image was taken from. |
| `image.bound_to` | `integer \| null` | ID of the server a backup belongs to; null for snapshots. |
| `image.created_from` | `object \| null` | Server the image was created from, or null. |
| `image.architecture` | `"x86" \| "arm"` | CPU architecture of the image. |
| `image.protection` | `object` | Protection of the image. |
| `image.protection.delete` | `boolean` | Delete protection. |
| `image.labels` | `object` | Labels (untrusted data). |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### List snapshots and backups

`snapshot_list`

**read-only · idempotent**

Lists snapshot and backup images of the project with size, status, labels and the server they were created from. Does not list system or app images; use the image catalog for those. Image size in GB determines the monthly cost of snapshots.

Annotations: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | `"snapshot" \| "backup"` | no |   | Only images of this type. Omit to list snapshots and backups. |
| `server_id` | `integer (min 1)` | no |   | Only backups bound to this server ID. Snapshots are not bound to a server. |
| `name` | `string` | no |   | Only images with exactly this name. |
| `label_selector` | `string` | no |   | Hetzner label selector, e.g. 'env=prod,!temporary' or 'env in (staging,test)'. |
| `sort` | `"id" \| "id:asc" \| "id:desc" \| "name" \| "name:asc" \| "name:desc" \| "created" \| "created:asc" \| "created:desc"` | no |   | Sort order: field, field:asc or field:desc (fields: id, name, created). |
| `page` | `integer (min 1)` | no | `1` | Page number, starting at 1 (default 1). |
| `per_page` | `integer (min 1, max 50)` | no | `25` | Entries per page (default 25, at most 50). |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `items` | `object[]` |   |
| `items[].id` | `integer` | ID of the image. |
| `items[].type` | `"snapshot" \| "backup" \| "system" \| "app"` | Type of the image. |
| `items[].status` | `"available" \| "creating" \| "unavailable"` | Status of the image. |
| `items[].name` | `string \| null` | Name of the image (untrusted data), or null. |
| `items[].description` | `string` | Description of the image (untrusted data). |
| `items[].created` | `string` | Creation time (ISO 8601). |
| `items[].image_size` | `number \| null` | Size in GB in storage; billing basis of snapshots. Null while unknown. |
| `items[].disk_size` | `number` | Size in GB of the disk the image was taken from. |
| `items[].bound_to` | `integer \| null` | ID of the server a backup belongs to; null for snapshots. |
| `items[].created_from` | `object \| null` | Server the image was created from, or null. |
| `items[].architecture` | `"x86" \| "arm"` | CPU architecture of the image. |
| `items[].protection` | `object` | Protection of the image. |
| `items[].protection.delete` | `boolean` | Delete protection. |
| `items[].labels` | `object` | Labels (untrusted data). |
| `page` | `integer` | Page number of this result. |
| `per_page` | `integer` | Page size used. |
| `next_page` | `integer \| null` | Next page number, or null if this is the last page. |
| `total_entries` | `integer \| null` | Total number of entries, or null if Hetzner did not report it. |

#### Update a snapshot or backup

`snapshot_update`

**write · idempotent**

Changes the description and/or replaces the complete label set of a snapshot or backup image. Only images of type snapshot and backup can be updated. Labels you send replace all existing labels, so include the ones to keep.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the image. |
| `description` | `string` | no |   | New description of the image. |
| `labels` | `object` | no |   | Labels as key/value pairs. Replaces the complete label set of the resource. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the image. |
| `type` | `"snapshot" \| "backup" \| "system" \| "app"` | Type of the image. |
| `status` | `"available" \| "creating" \| "unavailable"` | Status of the image. |
| `name` | `string \| null` | Name of the image (untrusted data), or null. |
| `description` | `string` | Description of the image (untrusted data). |
| `created` | `string` | Creation time (ISO 8601). |
| `image_size` | `number \| null` | Size in GB in storage; billing basis of snapshots. Null while unknown. |
| `disk_size` | `number` | Size in GB of the disk the image was taken from. |
| `bound_to` | `integer \| null` | ID of the server a backup belongs to; null for snapshots. |
| `created_from` | `object \| null` | Server the image was created from, or null. |
| `architecture` | `"x86" \| "arm"` | CPU architecture of the image. |
| `protection` | `object` | Protection of the image. |
| `protection.delete` | `boolean` | Delete protection. |
| `labels` | `object` | Labels (untrusted data). |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Delete a snapshot or backup

`snapshot_delete`

**destructive · idempotent · requires `confirm: true`**

Permanently deletes a snapshot or backup image. Only images of type snapshot and backup can be deleted, and not while delete protection is enabled. The image cannot be recovered; servers created from it earlier are not affected.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the snapshot or backup image (see snapshot_list). |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the deleted image. |
| `deleted` | `boolean` | True once Hetzner confirmed the deletion. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |

#### Set snapshot delete protection

`snapshot_protection_set`

**destructive · idempotent · requires `confirm: true`**

Turns delete protection of a snapshot on or off. With protection on, Hetzner refuses to delete the snapshot. Protection is never changed by other tools. Every call needs confirmation, also turning protection on, because the same tool can remove it. Works for snapshot images only; Hetzner rejects other image types.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | `integer (min 1)` | yes |   | ID of the image. |
| `protected` | `boolean` | yes |   | true turns delete protection on; false turns it off. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `id` | `integer` | ID of the image. |
| `protection` | `object` | Requested protection state; applied when the action succeeds. |
| `protection.delete` | `boolean` | Delete protection. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Enable automatic backups for a server

`backup_enable`

**write · not idempotent · can incur costs · requires `confirm: true`**

Enables the automatic daily backup option for a server, which keeps up to seven backup images. This raises the server's price by a fixed percentage (currently 20 %, see pricing) for as long as backups stay enabled. Does not create a backup immediately and returns no backup list; use snapshot_list with type backup. Requires confirmation; the preview shows the price change.

Annotations: `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=false`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `server_id` | `integer (min 1)` | yes |   | ID of the server. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server_id` | `integer` | ID of the server. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

#### Disable automatic backups for a server

`backup_disable`

**destructive · idempotent · requires `confirm: true`**

Disables the automatic backup option of a server and immediately deletes ALL its existing backup images, irreversibly. Snapshots are not affected. The backup surcharge on the server price stops.

Annotations: `readOnlyHint=false`, `destructiveHint=true`, `idempotentHint=true`, `openWorldHint=true`

**Parameters**

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `server_id` | `integer (min 1)` | yes |   | ID of the server. |
| `confirm` | `boolean` | no |   | Must be true to execute this operation (it destroys data or adds recurring cost). Only set it after the user approved the preview. |
| `wait` | `boolean` | no | `true` | Wait until the triggered Hetzner action(s) finish (at most HETZNER_MCP_ACTION_WAIT_MS). If false, or if the time is up, the result reports status 'running'; use action_get to follow up. |

**Output** (`structuredContent`)

| Name | Type | Description |
|---|---|---|
| `server_id` | `integer` | ID of the server. |
| `warnings` | `string[]` | Notices about this change (e.g. infrastructure-as-code markers). |
| `actions` | `object[]` | Hetzner actions triggered by this call, with their latest state. |
| `actions[].id` | `integer` | ID of the Hetzner action. |
| `actions[].command` | `string` | Command the action performs, e.g. start_server. |
| `actions[].status` | `"running" \| "success" \| "error"` | Status of the action. |
| `actions[].progress` | `integer` | Progress in percent (0-100). |
| `actions[].started` | `string` | Start time (ISO 8601). |
| `actions[].finished` | `string \| null` | End time (ISO 8601), or null while running. |
| `actions[].error` | `object \| null` | Error of a failed action, or null. |
| `actions[].resources` | `object[]` | Resources the action affects. |
| `actions[].resources[].id` | `integer` | ID of the resource. |
| `actions[].resources[].type` | `string` | Type of the resource, e.g. server. |

## Prompts

Prompts are guided workflows that instruct the model to use the tools above. They only instruct the model; every change still goes through the tools, so label scope, cost limit and confirmation apply. A prompt that creates resources is refused in read-only mode and, where it needs cost tools, with `HETZNER_MCP_ALLOW_COSTS=false`. The prompts name the toolsets they need.

### Audit project security

`audit_project_security`

Read-only security review of the Hetzner Cloud project (firewalls, exposed ports, backups, protection) that produces a prioritized list of findings.

| Argument | Required | Description |
|---|---|---|
| `label_selector` | no | Optional Hetzner label selector to limit the audit to some servers, e.g. 'env=prod'. |
| `ports` | no | Comma-separated TCP ports that should not be open to everyone (default: 22,3389,3306,5432,6379,27017,9200). |

### Provision web server

`provision_web_server`

Guided workflow to create a web server with an SSH key, a firewall for SSH, HTTP and HTTPS, optional cloud-init, and to wait until it is running. Shows costs before every step.

| Argument | Required | Description |
|---|---|---|
| `name` | yes | Server name (a valid hostname, unique in the project). |
| `location` | no | Location name, e.g. one listed by catalog_locations. |
| `server_type` | no | Server type name; if omitted the assistant proposes options with prices. |
| `image` | no | Image name; if omitted the assistant proposes a current system image. |
| `ssh_key` | no | Name or ID of an existing SSH key. |
| `ssh_sources` | no | Comma-separated CIDRs allowed to reach SSH (port 22), e.g. '203.0.113.7/32'. |

### Review costs

`review_costs`

Read-only review of what the Hetzner Cloud project costs per month, with a list of savings candidates (unused volumes, idle servers, old snapshots, backups).

| Argument | Required | Description |
|---|---|---|
| `snapshot_age_days` | no | Snapshots older than this many days are reported as candidates (default 30). |

## Resources

Read-only JSON resources, registered independently of the toolset selection.

| URI | Name | Description |
|---|---|---|
| `hetzner://inventory` | Hetzner project inventory | Counts of the resources in this Hetzner Cloud project by type, with the IDs of cost-relevant ones (servers off, unattached volumes, unassigned IPs). Contains no names or labels. |
| `hetzner://pricing` | Hetzner price list | Compact price list of this Hetzner Cloud project (VAT and currency of the project owner): server types per location, Primary and Floating IPs, volumes, snapshots and the backup surcharge. |
| `hetzner://servers/{id}` | Hetzner server | One server with the same fields as the server_get tool (no root password, no user data). |
