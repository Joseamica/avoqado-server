/**
 * Customer-MCP query digest — what operators DID through the MCP, segmented by
 * venue SECTOR (venue.type). This is the "moat / product signal" report: the raw
 * material for deciding which sector tools to build, which sectors get value, and
 * (later) any sector-specific "brain".
 *
 * Run (read-only, safe against prod):
 *   DATABASE_URL="postgresql://..." npx tsx -r dotenv/config scripts/mcp-query-digest.ts
 *   ... --days 7            # window (default 30)
 *
 * SOURCE: durable ActivityLog rows tagged data.source = 'customer-mcp' (every MCP
 * WRITE is audited there via src/mcp/audit.ts), joined to Venue.type for the sector.
 *
 * WHAT THIS DOES NOT SHOW (by design, today): read-only tool calls and failures —
 * the bulk of "what operators ASK" — are emitted by src/mcp/instrument.ts to the
 * app logger → BetterStack (filter `mcp:true`), NOT persisted to Postgres. The MCP
 * server never sees the natural-language question (that lives in the operator's LLM
 * client); it sees tool calls + outcomes. When real query volume justifies it,
 * promote that stream to a durable `McpToolCall` table so reads become a
 * sector-segmentable asset too. Pre-volume, a new table would be over-building.
 */
import prisma from '@/utils/prismaClient'

interface Row {
  sector: string
  action: string
  entity: string | null
  calls: number
  venues: number
  operators: number
  last_at: Date | null
}

function parseDays(): number {
  const i = process.argv.indexOf('--days')
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1])
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return 30
}

async function main() {
  const db = (await prisma.$queryRawUnsafe<{ current_database: string }[]>('SELECT current_database()'))[0]?.current_database
  const days = parseDays()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000) // ActivityLog.createdAt is real UTC (Prisma-written)

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `
    SELECT
      COALESCE(v.type::text, 'UNKNOWN')        AS sector,
      a.action                                 AS action,
      a.entity                                 AS entity,
      COUNT(*)::int                            AS calls,
      COUNT(DISTINCT a."venueId")::int         AS venues,
      COUNT(DISTINCT a."staffId")::int         AS operators,
      MAX(a."createdAt")                       AS last_at
    FROM "ActivityLog" a
    LEFT JOIN "Venue" v ON v.id = a."venueId"
    WHERE a.data->>'source' = 'customer-mcp'
      AND a."createdAt" >= $1
    GROUP BY sector, a.action, a.entity
    ORDER BY sector ASC, calls DESC
    `,
    since,
  )

  console.log(`\n===== CUSTOMER-MCP QUERY DIGEST =====`)
  console.log(`db=${db}  window=last ${days}d (since ${since.toISOString().slice(0, 10)})  source=customer-mcp (durable writes)\n`)

  if (rows.length === 0) {
    console.log('0 customer-MCP actions in this window.')
    console.log('→ The pipe is live; this is expected pre-launch (no real operator usage yet).')
    console.log('→ The real unlock is ADOPTION: get 1 operator using the MCP, then this fills with their sector signal.')
    console.log('→ Reads/failures (what they ask) are in BetterStack now: filter `mcp:true` (+ `venueId` for sector).\n')
    await prisma.$disconnect()
    return
  }

  const totalCalls = rows.reduce((s, r) => s + r.calls, 0)
  const sectors = [...new Set(rows.map(r => r.sector))]
  console.log(`TOTAL: ${totalCalls} actions · ${sectors.length} sector(s)\n`)

  for (const sector of sectors) {
    const sr = rows.filter(r => r.sector === sector)
    const sectorCalls = sr.reduce((s, r) => s + r.calls, 0)
    const venues = Math.max(...sr.map(r => r.venues))
    const operators = Math.max(...sr.map(r => r.operators))
    console.log(`── ${sector}  (${sectorCalls} actions · ${venues} venue(s) · ${operators} operator(s)) ──`)
    for (const r of sr.slice(0, 8)) {
      console.log(
        `   ${String(r.calls).padStart(4)} ×  ${r.action}${r.entity ? `  [${r.entity}]` : ''}   last ${r.last_at?.toISOString().slice(0, 10) ?? '—'}`,
      )
    }
    if (sr.length > 8) console.log(`   … +${sr.length - 8} more action types`)
    console.log('')
  }

  console.log('NOTE: writes only (audited). Reads + failures → BetterStack `mcp:true`. Promote to a durable')
  console.log('      McpToolCall table when volume justifies it (see header). Pre-volume = do not build.\n')
  await prisma.$disconnect()
}

main().catch(e => {
  console.error('digest failed:', e)
  process.exit(1)
})
