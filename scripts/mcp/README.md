# Avoqado Admin MCP (internal)

Local, single-user MCP server exposing read-only operational tools over stdio.

Smoke-test locally with `npm run mcp` (output goes to stderr). For **MCP registration,
launch `tsx` directly** (see below) — `npm run` prints its preamble (`> avoqado-server@…`)
to **stdout**, which is the MCP protocol channel, and would corrupt the handshake.

Full design: `docs/plans/2026-05-29-admin-mcp-design.md`.

## Tools

**Phase 1a — read only**
- `ping` — health check; returns which DB this process is pointed at
- `list_venues` / `list_orgs` — resolve venue/org ids
- `daily_sales` — sales summary for a venue/day (timezone-correct)
- `audit_terminals` — terminal TPV config audit + gap flags
- `find_order` / `find_payment` — support lookup by id or serial

**Phase 1b — verification search + writes (return a PREVIEW unless `confirm:true`)**
- `find_verifications` — search sale verifications for a venue (read)
- `reopen_verification` — COMPLETED → PENDING re-review (wraps the safe reopen service; never touches Payment/Order/SerializedItem)
- `move_terminal` — reassign a terminal to another venue (clears assigned merchants for cross-tenant safety)
- `update_user` — change a team member's role / active flag / PIN

Write tools need an actor staff id: set `MCP_ADMIN_STAFF_ID` in the `.env` that matches your
`DATABASE_URL` (per-DB), or pass `performedBy` per call. Every executed write is appended to
`logs/mcp-admin-audit.log`.

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

The server logs its DB target to stderr on startup. Write tools return a PREVIEW unless
called with `confirm:true`. Phase 2 (create_venue+KYC, create_merchant) is pending.
