/**
 * Dev-only standalone server for the customer MCP (Phase 0).
 *
 * Serves ONLY the `/mcp` endpoint on a minimal Express app — it does NOT boot the
 * full Avoqado backend (no Blumon/Email/Socket.IO), so it's light on the machine.
 * On startup it prints a ready-to-paste `claude mcp add` command with a fresh
 * 24h MCP token so you can connect a real Claude and try the scoped read loop.
 *
 * Usage (from this worktree):
 *   npx tsx scripts/mcp-dev-server.ts                # auto-picks an active OWNER from the DB
 *   npx tsx scripts/mcp-dev-server.ts <staffId> <orgId>   # specific staff + org
 *
 * Env: MCP_DEV_PORT (default 4100). Reads DATABASE_URL + ACCESS_TOKEN_SECRET from .env.
 */
import 'dotenv/config'
import express from 'express'
import prisma from '@/utils/prismaClient'
import { issueMcpToken } from '@/mcp/mcpToken'
import { handleMcpRequest } from '@/mcp/server'

const PORT = Number(process.env.MCP_DEV_PORT ?? 4100)

async function main() {
  let staffId = process.argv[2]
  let orgId = process.argv[3]

  if (!staffId || !orgId) {
    const owner = await prisma.staffOrganization.findFirst({
      where: { role: 'OWNER', isActive: true },
      select: { staffId: true, organizationId: true, organization: { select: { name: true } } },
    })
    if (!owner) {
      console.error('No active OWNER membership found. Pass: npx tsx scripts/mcp-dev-server.ts <staffId> <orgId>')
      process.exit(1)
    }
    staffId = owner.staffId
    orgId = owner.organizationId
    console.log(`\nAuto-selected OWNER: staff=${staffId}  org="${owner.organization?.name}" (${orgId})`)
  }

  const token = issueMcpToken(staffId, orgId, 24 * 3600) // 24h dev token

  const app = express()
  app.post('/mcp', express.json(), handleMcpRequest)
  app.listen(PORT, () => {
    const url = `http://127.0.0.1:${PORT}/mcp`
    console.log(`\n  ✅ Customer MCP (dev) listening on ${url}\n`)
    console.log('  Connect a real Claude/ChatGPT (run this in another terminal):\n')
    console.log(`  claude mcp add --transport http avoqado-cliente ${url} --header "Authorization: Bearer ${token}"\n`)
    console.log('  Then, in that Claude session, ask:  "lista mis venues"')
    console.log('  Expected: only the venues in this staff+org scope.\n')
    console.log('  (Ctrl-C to stop.)\n')
  })
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
