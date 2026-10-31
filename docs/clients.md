# MCP client configuration

The server is a standard **stdio** MCP server, started with `npx -y hetzner-model-context-protocol` (Node.js 22 or newer). All snippets use a read-only starting point; see [getting-started](getting-started.md) for creating the API token and [configuration](configuration.md) for every variable.

Common placeholders:

| Placeholder | Meaning |
| --- | --- |
| `<api-token>` | The API token of the Hetzner Cloud project. Never commit it. |

Optional settings (`HETZNER_MCP_READ_ONLY`, `HETZNER_MCP_TOOLSETS`, `HETZNER_MCP_LABEL_SCOPE`, `HETZNER_MCP_ALLOW_COSTS`, ...) go into the same `env` block. A sensible start is `"HETZNER_MCP_READ_ONLY": "true"` together with a Read-only token.

## How to handle the token

| Client | Token handling | Plain text in a file? |
| --- | --- | --- |
| Claude Code | `${VAR}` expansion from your shell environment | no |
| VS Code | `inputs` with `promptString` (password), asked once and stored by VS Code | no |
| Cursor | `${env:VAR}` interpolation | no |
| Claude Desktop | no variable expansion; use a wrapper script that reads from a keychain, or accept a plain-text config file | yes, unless you use the wrapper |
| Generic / others | environment of the launching process | depends |

## Claude Desktop

Edit `claude_desktop_config.json` (Settings > Developer > Edit Config; macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) and restart Claude Desktop.

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

Claude Desktop passes `env` values literally, so the token sits in this file. Restrict the file's permissions (`chmod 600` on macOS and Linux), or keep the token out of it with a small wrapper script. Example for macOS, with the token stored in the Keychain (`security add-generic-password -a "$USER" -s hetzner-mcp -w`):

```bash
#!/bin/sh
# ~/bin/hetzner-mcp.sh   (chmod +x)
export HETZNER_TOKEN="$(security find-generic-password -s hetzner-mcp -w)"
exec npx -y hetzner-model-context-protocol
```

```json
{
  "mcpServers": {
    "hetzner": {
      "command": "/Users/you/bin/hetzner-mcp.sh",
      "env": {
        "HETZNER_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

Notes:

- Claude Desktop starts GUI-launched processes with a minimal `PATH`. If `npx` is not found, use the absolute path (for example from `which npx`) as `command`.
- On Windows, if `npx` cannot be started directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "hetzner-model-context-protocol"]`.
- For a local build use `"command": "node"` and `"args": ["/absolute/path/to/dist/index.js"]`.
- Prompts show up in the attachment menu of a chat; resources can be attached from the same menu.

## Claude Code

```bash
export HETZNER_TOKEN='<api-token>'

claude mcp add --transport stdio \
  --env HETZNER_TOKEN='${HETZNER_TOKEN}' \
  --env HETZNER_MCP_READ_ONLY=true \
  hetzner -- npx -y hetzner-model-context-protocol
```

Keep the single quotes around `'${HETZNER_TOKEN}'`: the literal `${...}` is stored in the configuration and expanded by Claude Code when it starts the server, so the token itself is never written to the config. The variable has to exist in the shell from which you start `claude`.

- Scope: `--scope local` (default, only you in this project), `--scope project` (writes `.mcp.json`, shareable and safe to commit because it contains no token) or `--scope user` (all your projects).
- Check with `claude mcp list` and, inside a session, `/mcp`.
- Prompts are available as slash commands such as `/mcp__hetzner__review_costs`.
- More toolsets: add `--env HETZNER_MCP_TOOLSETS=all`.

## VS Code

Create `.vscode/mcp.json` in the workspace (or use the user-level MCP configuration). The `inputs` entry makes VS Code ask for the token once and keeps it out of the file.

```jsonc
{
  "inputs": [
    {
      "type": "promptString",
      "id": "hetzner-token",
      "description": "Hetzner Cloud API token",
      "password": true
    }
  ],
  "servers": {
    "hetzner": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "hetzner-model-context-protocol"],
      "env": {
        "HETZNER_TOKEN": "${input:hetzner-token}",
        "HETZNER_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

Start the server from the code lens above `"hetzner"` in the file or via the command palette (*MCP: List Servers*). Tools appear in Copilot Chat in agent mode; prompts are available as `/` commands.

## Cursor

Create `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` globally). Values are interpolated from your environment, so export the variable before starting Cursor.

```jsonc
{
  "mcpServers": {
    "hetzner": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "hetzner-model-context-protocol"],
      "env": {
        "HETZNER_TOKEN": "${env:HETZNER_TOKEN}",
        "HETZNER_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

Enable the server under *Settings > MCP*. A Cursor started from the Dock or Start menu does not see variables exported in a terminal; start it from a shell (`cursor .`) or set the variable system-wide.

## Generic stdio client

Any MCP client that can start a stdio server works. Provide:

| Field | Value |
| --- | --- |
| Command | `npx` |
| Arguments | `-y hetzner-model-context-protocol` |
| Transport | stdio |
| Environment | `HETZNER_TOKEN` and any `HETZNER_MCP_*` settings |

Or from a shell, for example to test:

```bash
HETZNER_TOKEN='<api-token>' \
HETZNER_MCP_READ_ONLY=true \
npx -y hetzner-model-context-protocol
```

The process then waits for JSON-RPC on stdin; logs go to stderr. Interactive testing is easier with the [MCP Inspector](getting-started.md#4-test-with-the-mcp-inspector).

## Waiting for actions and client timeouts

Tools that start Hetzner actions wait for up to `HETZNER_MCP_ACTION_WAIT_MS` (default 50 seconds) and report progress if the client asks for it. The MCP SDK uses a 60 second request timeout by default, and a progress notification extends it only if the client enables that. How long other clients wait is not documented. If a client drops long calls, set `HETZNER_MCP_ACTION_WAIT_MS` lower (or `0`) and let the assistant follow up with `action_get`. See [configuration](configuration.md#timeouts-and-waiting).

## Troubleshooting a client setup

- **Server not listed / fails to start:** run the same command with the same variables in a terminal; configuration errors are printed to stderr and the process exits. See [troubleshooting](troubleshooting.md).
- **`npx` not found or wrong Node version:** the client's `PATH` may differ from your shell. Use absolute paths, and make sure `node --version` shows 22 or newer for that `PATH`.
- **Token not applied:** check that the variable is exported in the environment of the process that starts the client (Claude Code: your shell; Cursor: the shell that launched it).
