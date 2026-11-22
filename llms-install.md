# Installing remove-ac MCP Server (for AI Agents)

Follow these steps in order to install and verify the official `remove.ac` Model Context Protocol (MCP) stdio server (`remove-ac@1.3.1`, Official MCP Registry ID `io.github.szp2005/remove-ac`) in Cline, Claude Desktop, Cursor, VS Code, or Windsurf.

## 1. Check Node.js Prerequisite

```bash
node --version
```

Node.js `18.0.0` or newer is required. The `remove-ac` package has zero runtime npm dependencies and runs over standard `stdio`. If Node.js is older than `18.0.0`, stop and ask the user to upgrade Node.js first.

## 2. Verify the MCP Server Binary and Handshake (No API Key Required)

Run this read-only stdio handshake check to confirm `npx` fetches `remove-ac@1.3.1` cleanly and lists all three tools:

```bash
npx -y -p remove-ac@1.3.1 remove-ac-mcp --version
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cline-installer","version":"1.0.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | npx -y -p remove-ac@1.3.1 remove-ac-mcp
```

Expected output:
- Version line: `1.3.1`
- JSON-RPC `tools/list` response containing `remove_background_file`, `remove_background_url`, and `get_account_balance`.

## 3. Obtain an API Key from the User

Tool execution calls the stateless `remove.ac` Cloud GPU API (`POST https://remove.ac/v1.0/removebg`, zero disk persistence, `0` credits billed on errors) and requires a `REMOVE_AC_API_KEY` (`rac_live_...`).

Ask the user for their `REMOVE_AC_API_KEY` before running live cutouts (never hardcode or commit an API key into git):
- Users without a key can create a verified email account at https://remove.ac/api-info (includes `10` free full-resolution Cloud GPU credits valid for `30` days, no credit card required).

## 4. Add `remove-ac` to MCP Settings

Merge the `"remove-ac"` server entry into the active client's MCP settings JSON (preserving all existing `mcpServers` entries):

- **Cline (VS Code on macOS)**: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Cline (VS Code on Linux)**: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Cline (VS Code on Windows)**: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- **Cline CLI**: `~/.cline/data/settings/cline_mcp_settings.json`
- **Claude Desktop (macOS)**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Cursor**: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "remove-ac": {
      "command": "npx",
      "args": ["-y", "-p", "remove-ac", "remove-ac-mcp"],
      "env": {
        "REMOVE_AC_API_KEY": "REPLACE_WITH_USER_API_KEY"
      }
    }
  }
}
```

## 5. Available MCP Tools

1. `remove_background_file`: Remove the background from a local `.png`, `.jpg`, `.jpeg`, or `.webp` image up to `25 MB / 50 MP` (`inputPath`, optional `outputPath`, `overwrite`, `size`, `format`, `bgColor`, `bgImagePath`, `bgImageUrl`, `crop`, `type`, `addShadow`, `shadowType`). Files above `4 MB` stream automatically via `180s` single-use `/v1.0/removebg/ticket`.
2. `remove_background_url`: Remove the background from a public HTTPS/HTTP image URL (`imageUrl`, `outputPath`, plus shared cutout options) with built-in DNS/IP SSRF protection and save the cutout locally.
3. `get_account_balance`: Check the remaining `remove.ac` API credit balance via `GET /v1.0/account` (`0` credits charged).

## 6. Post-Install Smoke Test

Once the user sets `REMOVE_AC_API_KEY`, call `get_account_balance` through MCP to confirm authentication succeeds without spending any credits.
