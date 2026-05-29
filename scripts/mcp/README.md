# Avoqado Admin MCP (internal)

Local, single-user MCP server exposing read-only operational tools over stdio.
Run with `npm run mcp`. See `docs/plans/2026-05-29-admin-mcp-design.md` for the full design.

## Tools (Phase 1a — read only)

- `ping` — health check; returns which DB this process is pointed at
- `list_venues` / `list_orgs` — resolve venue/org ids
- `daily_sales` — sales summary for a venue/day (timezone-correct)
- `audit_terminals` — terminal TPV config audit + gap flags
- `find_order` / `find_payment` — support lookup by id or serial

## Register in Claude

Add to your MCP config (project `.mcp.json` or global), pointing `DOTENV_CONFIG_PATH`
at the environment you want (⚠️ this server reads whatever `DATABASE_URL` is set):

```json
{
  "mcpServers": {
    "avoqado-admin": {
      "command": "tsx",
      "args": ["scripts/mcp/server.ts"],
      "cwd": "/Users/amieva/Documents/Programming/Avoqado/avoqado-server",
      "env": { "DOTENV_CONFIG_PATH": ".env" }
    }
  }
}
```

The server logs its DB target to stderr on startup. Phase 1a is read-only; write tools
(Phase 1b+) will add preview+confirm guards.
