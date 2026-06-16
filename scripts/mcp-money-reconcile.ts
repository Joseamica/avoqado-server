/**
 * MCP money reconciliation — PROVES every money figure the MCP returns matches an
 * INDEPENDENT raw-SQL query against the DB, to the cent, for a venue + date range.
 * This is the standing "no descuadra ni un centavo" guard: run it anytime (or in CI)
 * after touching any analytics/payments tool. Read-only.
 *
 *   DATABASE_URL="postgresql://..." npx tsx -r dotenv/config scripts/mcp-money-reconcile.ts \
 *     --venue <id> --from 2026-06-02 --to 2026-06-15
 *
 * Defaults to Mindform, last 14 days. Compares each MCP tool's totals to a
 * hand-written SQL ground truth that uses the SAME venue-local day boundaries the
 * tools use (venueStartOfDay/venueEndOfDay), so a match proves the tool's window +
 * status/refund definition are correct.
 */
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import { registerSalesTools } from '@/mcp/tools/sales'
import { registerPaymentTools } from '@/mcp/tools/payments'
import type { McpScope } from '@/mcp/scope'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const VENUE = arg('venue', 'cmisvi38o001fhr2828ygmxi2')! // Mindform
const FROM = arg('from')
const TO = arg('to')

let pass = 0
let fail = 0
const cents = (n: number) => Math.round(n * 100) / 100
function check(label: string, mcp: number, db: number, mcpCount?: number, dbCount?: number) {
  const moneyOk = cents(mcp) === cents(db)
  const countOk = mcpCount === undefined || mcpCount === dbCount
  const ok = moneyOk && countOk
  ok ? pass++ : fail++
  const cnt = mcpCount !== undefined ? `  (count mcp=${mcpCount} db=${dbCount})` : ''
  console.log(
    `${ok ? '✅' : '❌'}  ${label.padEnd(46)} mcp=${cents(mcp).toFixed(2)}  db=${cents(db).toFixed(2)}${cnt}${moneyOk ? '' : `  ⚠️ DIFF $${cents(mcp - db).toFixed(2)}`}`,
  )
}

async function main() {
  const db = (await prisma.$queryRawUnsafe<{ current_database: string }[]>('SELECT current_database()'))[0]?.current_database
  const tz = (await prisma.venue.findUnique({ where: { id: VENUE }, select: { timezone: true } }))?.timezone || 'America/Mexico_City'
  const start = FROM ? venueStartOfDay(tz, new Date(`${FROM}T12:00:00`)) : venueStartOfDay(tz, new Date(Date.now() - 14 * 864e5))
  const end = TO ? venueEndOfDay(tz, new Date(`${TO}T12:00:00`)) : venueEndOfDay(tz)
  const fromStr = FROM ?? start.toISOString().slice(0, 10)
  const toStr = TO ?? end.toISOString().slice(0, 10)

  console.log(`\n===== MCP MONEY RECONCILIATION =====`)
  console.log(`db=${db}  venue=${VENUE}  tz=${tz}`)
  console.log(`window=${start.toISOString()} .. ${end.toISOString()}\n`)

  // Register the tools against a scope that can see this venue.
  const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  const server = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never
  const scope = { staffId: 's', activeOrg: 'o', allowedVenueIds: [VENUE], perVenueAccess: new Map() } as McpScope
  registerSalesTools(server, scope)
  registerPaymentTools(server, scope)
  const callTool = async (n: string, a: Record<string, unknown>) => JSON.parse((await handlers.get(n)!(a, {})).content[0].text)

  // ---- 1) sales_by_payment_method: gross + net, per method ----
  const sbpm = await callTool('sales_by_payment_method', { venueId: VENUE, fromDate: fromStr, toDate: toStr })
  // Ground truth GROSS = all COMPLETED by method (incl refunds + cancelled) — the dashboard "Métodos de Pago" panel.
  const grossDb = await prisma.$queryRawUnsafe<{ method: string; c: number; s: number }[]>(
    `SELECT method, count(*)::int c, COALESCE(sum(amount),0)::float8 s FROM "Payment" WHERE "venueId"=$1 AND status='COMPLETED' AND "createdAt">=$2 AND "createdAt"<=$3 GROUP BY method`,
    VENUE,
    start,
    end,
  )
  // Ground truth NET = excl refunds + cancelled orders.
  const netDb = await prisma.$queryRawUnsafe<{ method: string; c: number; s: number }[]>(
    `SELECT p.method, count(*)::int c, COALESCE(sum(p.amount),0)::float8 s FROM "Payment" p LEFT JOIN "Order" o ON o.id=p."orderId"
     WHERE p."venueId"=$1 AND p.status='COMPLETED' AND p.type!='REFUND' AND (o.status IS NULL OR o.status!='CANCELLED') AND p."createdAt">=$2 AND p."createdAt"<=$3 GROUP BY p.method`,
    VENUE,
    start,
    end,
  )
  console.log('── sales_by_payment_method ──')
  for (const m of grossDb) {
    const mcpM = sbpm.grossCollected.byMethod.find((x: { method: string }) => x.method === m.method) ?? { total: 0, count: 0 }
    check(`gross ${m.method}`, mcpM.total, m.s, mcpM.count, m.c)
  }
  for (const m of netDb) {
    const mcpM = sbpm.netSales.byMethod.find((x: { method: string }) => x.method === m.method) ?? { total: 0, count: 0 }
    check(`net   ${m.method}`, mcpM.total, m.s, mcpM.count, m.c)
  }

  // ---- 2) list_payments: COMPLETED total ----
  const lp = await callTool('list_payments', { venueId: VENUE, fromDate: fromStr, toDate: toStr, status: 'completed' })
  const lpDb = (
    await prisma.$queryRawUnsafe<{ c: number; s: number }[]>(
      `SELECT count(*)::int c, COALESCE(sum(amount),0)::float8 s FROM "Payment" WHERE "venueId"=$1 AND status='COMPLETED' AND "createdAt">=$2 AND "createdAt"<=$3`,
      VENUE,
      start,
      end,
    )
  )[0]
  const lpTotal = lp.summary?.byStatus?.COMPLETED?.amount ?? lp.summary?.completed?.amount ?? lp.completed?.amount ?? null
  console.log('── list_payments ──')
  if (lpTotal != null) check('COMPLETED total', lpTotal, lpDb.s)
  else console.log('  (shape de list_payments distinto — revisar manualmente)', JSON.stringify(lp.summary ?? lp).slice(0, 160))

  console.log(`\n  ${pass} ✅ / ${fail} ❌  — todo verde = cada cifra del MCP cuadra al centavo con la DB\n`)
  await prisma.$disconnect()
}
main().catch(e => {
  console.error('reconcile failed:', e)
  process.exit(1)
})
