/**
 * Issue a scoped customer-MCP token + the ready-to-paste `claude mcp add` line for a
 * REAL operator, by email. Use this to demo with the customer's OWN venues (far more
 * convincing than seed data).
 *
 * Usage:  npx tsx scripts/mcp-token-for.ts operator@cliente.com
 * The dev server must be running (npm run dev) on MCP_PORT (default 4100).
 * NOTE: the URL is localhost — works for a guided/screen-share or in-person demo.
 *       A remote hands-off trial needs a staging deploy (not built yet).
 */
import 'dotenv/config'
import prisma from '@/utils/prismaClient'
import { issueMcpToken } from '@/mcp/mcpToken'
import { resolveScope } from '@/mcp/scope'
import { getPrimaryOrganizationId } from '@/services/staffOrganization.service'

async function main() {
  const email = process.argv[2]?.toLowerCase()
  if (!email) {
    console.error('Usage: npx tsx scripts/mcp-token-for.ts <operator-email>')
    process.exit(1)
  }
  const staff = await prisma.staff.findUnique({ where: { email }, select: { id: true, firstName: true, lastName: true } })
  if (!staff) {
    console.error(`No staff found with email "${email}". Check it exists in this DB.`)
    process.exit(1)
  }

  let org: string
  try {
    org = await getPrimaryOrganizationId(staff.id)
  } catch {
    console.error(`"${email}" has no active/primary organization — cannot scope a token.`)
    process.exit(1)
  }

  const scope = await resolveScope(staff.id, org)
  const ttlHours = 12
  const token = issueMcpToken(staff.id, org, ttlHours * 3600)
  const port = process.env.MCP_PORT ?? '4100'

  const name = `${staff.firstName ?? ''} ${staff.lastName ?? ''}`.trim() || email
  console.log(`\n  Operator : ${name} <${email}>`)
  console.log(`  Org      : ${org}`)
  console.log(`  Venues   : ${scope.allowedVenueIds.length} in scope`)
  console.log(`  Token    : valid ${ttlHours}h\n`)
  console.log(`  Run this where their Claude Code lives:\n`)
  console.log(`  claude mcp add --transport http avoqado http://localhost:${port}/mcp --header "Authorization: Bearer ${token}"\n`)

  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
