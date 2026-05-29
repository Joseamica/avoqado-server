# Avoqado Admin MCP (internal)

Local, single-user MCP server exposing read-only operational tools over stdio.

Smoke-test locally with `npm run mcp` (output goes to stderr). For **MCP registration,
launch `tsx` directly** (see below) — `npm run` prints its preamble (`> avoqado-server@…`)
to **stdout**, which is the MCP protocol channel, and would corrupt the handshake.

Full design: `docs/plans/2026-05-29-admin-mcp-design.md`.

## Tools (Phase 1a — read only)

- `ping` — health check; returns which DB this process is pointed at
- `list_venues` / `list_orgs` — resolve venue/org ids
- `daily_sales` — sales summary for a venue/day (timezone-correct)
- `audit_terminals` — terminal TPV config audit + gap flags
- `find_order` / `find_payment` — support lookup by id or serial

## Register in Claude

Add to your MCP config (project `.mcp.json` or global). Use the local `tsx` binary (not
bare `tsx`, which assumes a global install). Prisma auto-loads `.env` from `cwd`, so the
DB target is whatever that `.env`'s `DATABASE_URL` points to — ⚠️ check it before running.

```json
{
  "mcpServers": {
    "avoqado-admin": {
      "command": "node_modules/.bin/tsx",
      "args": ["scripts/mcp/server.ts"],
      "cwd": "/Users/amieva/Documents/Programming/Avoqado/avoqado-server"
    }
  }
}
```

The server logs its DB target to stderr on startup. Phase 1a is read-only; write tools
(Phase 1b+) will add preview+confirm guards.
