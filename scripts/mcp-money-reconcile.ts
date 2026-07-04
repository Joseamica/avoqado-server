/**
 * MCP money reconciliation — PROVES every money figure the MCP returns matches an
 * INDEPENDENT raw-SQL query against the DB, to the cent, for a venue + date range.
 * This is the standing "no descuadra ni un centavo" guard: run it anytime (or in CI)
 * after touching any analytics/payments tool. Read-only.
 *
 *   DATABASE_URL="postgresql://..." npx tsx -r dotenv/config scripts/mcp-money-reconcile.ts \
 *     --venue <id> --from 2026-06-02 --to 2026-06-15
 *
 * Defaults to an entitled venue with native payments (Mobanq), last 14 days. Compares each MCP tool's totals to a
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

const VENUE = arg('venue', 'cmpe64yq2001f9k92m0lbhmf4')! // Mobanq (plan-exempt, native payments)
const FROM = arg('from')
const TO = arg('to')

let pass = 0
let fail = 0
const cents = (n: number) => Math.round(n * 100) / 100
function check(label: string, mcp: number, db: number, mcpCount?: number, dbCount?: number) {
  const moneyOk = cents(mcp) === cents(db)
  const countOk = mcpCount === undefined || mcpCount === dbCount
  const ok = moneyOk && countOk
  if (ok) pass++
  else fail++
  const cnt = mcpCount !== undefined ? `  (count mcp=${mcpCount} db=${dbCount})` : ''
  console.log(
    `${ok ? '✅' : '❌'}  ${label.padEnd(46)} mcp=${cents(mcp).toFixed(2)}  db=${cents(db).toFixed(2)}${cnt}${moneyOk ? '' : `  ⚠️ DIFF $${cents(mcp - db).toFixed(2)}`}`,
  )
}

function requireToolResult(name: string, value: Record<string, any>): Record<string, any> {
  if (!value || value.ok === false || value.planRequired) {
    throw new Error(`${name} no pudo ejecutarse: ${value?.error ?? 'respuesta vacía o inválida'}`)
  }
  return value
}

function checkMethods(
  label: string,
  mcpRows: Array<{ method: string; total: number; count: number }>,
  dbRows: Array<{ method: string; s: number; c: number }>,
) {
  const mcp = new Map(mcpRows.map(r => [r.method, r]))
  const db = new Map(dbRows.map(r => [r.method, r]))
  const methods = new Set([...mcp.keys(), ...db.keys()])
  for (const method of methods) {
    const m = mcp.get(method) ?? { total: 0, count: 0 }
    const d = db.get(method) ?? { s: 0, c: 0 }
    check(`${label} ${method}`, m.total, d.s, m.count, d.c)
  }
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
  // Synthetic full-read access — guard.requirePermission hard-denies venues missing from perVenueAccess.
  const scope = {
    staffId: 's',
    activeOrg: 'o',
    allowedVenueIds: [VENUE],
    perVenueAccess: new Map([[VENUE, { role: 'OWNER', corePermissions: ['*:*'] }]]),
  } as unknown as McpScope
  registerSalesTools(server, scope)
  registerPaymentTools(server, scope)
  const callTool = async (n: string, a: Record<string, unknown>) => {
    const handler = handlers.get(n)
    if (!handler) throw new Error(`Tool ${n} no registrado`)
    const parsed = JSON.parse((await handler(a, {})).content[0].text) as Record<string, any>
    return requireToolResult(n, parsed)
  }

  // ---- 1) sales_by_payment_method: gross + net, per method ----
  const sbpm = await callTool('sales_by_payment_method', { venueId: VENUE, fromDate: fromStr, toDate: toStr })
  // Ground truth GROSS = all COMPLETED by method (incl refunds-as-negatives + cancelled) INCLUDING TIPS —
  // mirrors the dashboard "Métodos de Pago" panel (sum(amount + tipAmount), no type/order filter).
  const grossDb = await prisma.$queryRawUnsafe<{ method: string; c: number; s: number }[]>(
    `SELECT method, count(*)::int c, COALESCE(sum(amount + COALESCE("tipAmount",0)),0)::float8 s FROM "Payment" WHERE "venueId"=$1 AND status='COMPLETED' AND "createdAt">=$2 AND "createdAt"<=$3 GROUP BY method`,
    VENUE,
    start,
    end,
  )
  // Ground truth NET = COMPLETED incl refunds-as-negatives (so refunds ARE subtracted), excl cancelled
  // orders, amount only (no tips). Refund rows keep type=REFUND but are NOT filtered out here — that is
  // exactly what makes netSales "net of refunds".
  const netDb = await prisma.$queryRawUnsafe<{ method: string; c: number; s: number }[]>(
    `SELECT p.method, count(*)::int c, COALESCE(sum(p.amount),0)::float8 s FROM "Payment" p LEFT JOIN "Order" o ON o.id=p."orderId"
     WHERE p."venueId"=$1 AND p.status='COMPLETED' AND (o.status IS NULL OR o.status!='CANCELLED') AND p."createdAt">=$2 AND p."createdAt"<=$3 GROUP BY p.method`,
    VENUE,
    start,
    end,
  )
  console.log('── sales_by_payment_method ──')
  check(
    'gross total',
    sbpm.grossCollected.total,
    grossDb.reduce((sum, r) => sum + r.s, 0),
  )
  check(
    'net total',
    sbpm.netSales.total,
    netDb.reduce((sum, r) => sum + r.s, 0),
  )
  checkMethods('gross', sbpm.grossCollected.byMethod, grossDb)
  checkMethods('net  ', sbpm.netSales.byMethod, netDb)

  // ---- 2) list_payments: completed (SALES, refunds excluded) + refunds bucket ----
  // NOTE: since the 2026-07-03 fix, `completed.gross` is COMPLETED minus type=REFUND (true sales),
  // and refunds live in their own bucket (negative). Ground truth must split the same way.
  const lp = await callTool('list_payments', { venueId: VENUE, fromDate: fromStr, toDate: toStr, status: 'all' })
  const lpSalesDb = (
    await prisma.$queryRawUnsafe<{ c: number; s: number }[]>(
      `SELECT count(*)::int c, COALESCE(sum(amount),0)::float8 s FROM "Payment" WHERE "venueId"=$1 AND status='COMPLETED' AND (type IS NULL OR type!='REFUND') AND "createdAt">=$2 AND "createdAt"<=$3`,
      VENUE,
      start,
      end,
    )
  )[0]
  const lpRefundDb = (
    await prisma.$queryRawUnsafe<{ c: number; s: number }[]>(
      `SELECT count(*)::int c, COALESCE(sum(amount),0)::float8 s FROM "Payment" WHERE "venueId"=$1 AND (type='REFUND' OR status='REFUNDED') AND "createdAt">=$2 AND "createdAt"<=$3`,
      VENUE,
      start,
      end,
    )
  )[0]
  console.log('── list_payments ──')
  check('completed gross (sales, no refunds)', lp.summary?.completed?.gross ?? 0, lpSalesDb.s, lp.summary?.completed?.count, lpSalesDb.c)
  check('refunds (negative, split out)', lp.summary?.refunds?.amount ?? 0, lpRefundDb.s, lp.summary?.refunds?.count, lpRefundDb.c)

  // ---- 3) staff_tips: per-staff tips == DB grouped by processedById (corte-de-caja rule) ----
  // Ground truth mirrors fetchPaymentsForAnalytics defaults: COMPLETED, no REFUND, no cancelled orders,
  // tipped payments only. NOTE: for MindForm, legacy QR rows live in another DB and land in `unattributed`
  // on the MCP side but not in this SQL — per-staff rows are exact for every venue regardless.
  const st = await callTool('staff_tips', { venueId: VENUE, fromDate: fromStr, toDate: toStr })
  const tipsDb = await prisma.$queryRawUnsafe<{ sid: string | null; name: string | null; c: number; s: number }[]>(
    `SELECT p."processedById" sid, trim(concat(st."firstName", ' ', st."lastName")) name, count(*)::int c, COALESCE(sum(p."tipAmount"),0)::float8 s
     FROM "Payment" p LEFT JOIN "Order" o ON o.id=p."orderId" LEFT JOIN "Staff" st ON st.id=p."processedById"
     WHERE p."venueId"=$1 AND p.status='COMPLETED' AND p.type!='REFUND' AND (o.status IS NULL OR o.status!='CANCELLED')
       AND p."tipAmount">0 AND p."createdAt">=$2 AND p."createdAt"<=$3
     GROUP BY p."processedById", name ORDER BY s DESC`,
    VENUE,
    start,
    end,
  )
  console.log('── staff_tips ──')
  for (const r of tipsDb) {
    if (r.sid === null) {
      check('unattributed (sin cajero)', st.unattributed.tips, r.s, st.unattributed.payments, r.c)
      continue
    }
    const mcpS = st.staff.find((x: { staffId: string }) => x.staffId === r.sid) ?? { tips: 0, payments: 0 }
    check(`tips ${(r.name || r.sid).slice(0, 24)}`, mcpS.tips, r.s, mcpS.payments, r.c)
  }
  // Internal consistency: staff_tips venue total must equal tips_over_time for the same window.
  const tot = await callTool('tips_over_time', { venueId: VENUE, fromDate: fromStr, toDate: toStr })
  check('total == tips_over_time', st.total, tot.total, st.tippedPayments, tot.count)

  console.log(`\n  ${pass} ✅ / ${fail} ❌  — todo verde = cada cifra del MCP cuadra al centavo con la DB\n`)
  await prisma.$disconnect()
  if (fail > 0) process.exitCode = 1
}
main().catch(e => {
  console.error('reconcile failed:', e)
  process.exit(1)
})
