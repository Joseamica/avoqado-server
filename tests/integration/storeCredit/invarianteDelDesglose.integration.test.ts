/**
 * S10 r3 (rediseño, ruling del controlador tras Codex código r3): la INVARIANTE del desglose por método de pago. En el desglose y en la
 * exportación, del DASHBOARD y del MCP, toda fila con importe bruto, reverso o neto ≠ 0 tiene conteo > 0 y aparece.
 *
 * El defecto que la rompía venía de una regla («un cobro mixto cuenta en su parte mayor», S8b r1 M3): creaba filas con importe y sin
 * conteo, y las compuertas que piden «conteo > 0 o neto ≠ 0» las escondían (r2 en la barra de ventas; r3 en la exportación: $300 de
 * saldo a favor + $200 de tarjeta vendida, devuelto completo ⇒ la tarjeta vendida con conteo 0 y neto 0 ⇒ $200 consumidos y $200
 * devueltos fuera). Ahora se cuenta POR PATA: un cobro mixto cuenta en cada medio que usó, como el desglose por medio de pago del mercado.
 *
 * Cuatro negocios, uno por caso: el de r3, el de r2, un cobro normal sin saldo y una tarjeta vendida sola.
 *
 * Correr (en la nube, con su propia base; el veredicto está en el CUERPO, no en el exit):
 *   cd /Users/amieva/Documents/Programming/Avoqado && AVQ_TREE=$HOME/.claude/worktrees/saldo-a-favor/avoqado-server \
 *     ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "invarianteDelDesglose" --ci
 *
 * La libreta no se puede borrar (trigger): los sobres se quedan en la base desechable; cada negocio es único.
 */
import { formatInTimeZone } from 'date-fns-tz'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { issueRefund, type AbonarSaldoAFavor } from '@/services/dashboard/refund.dashboard.service'
import { abonarSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'
import { prepararMediosDeSaldoAFavor } from '@/services/storeCredit/storeCreditTender'
import {
  flattenSalesSummaryForExport,
  getSalesSummary,
  type SalesSummaryExportRow,
  type SalesSummaryResponse,
} from '@/services/dashboard/sales-summary.dashboard.service'
import { registerSalesTools } from '@/mcp/tools/sales'
import type { McpScope } from '@/mcp/scope'
import { seedClothingSale } from '../exchanges/seedExchange'
import { sembrarCanje, sembrarVentaDeTarjetas } from '../giftCards/sembrarTarjetasDeRegalo'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn(), getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({ generateDigitalReceipt: jest.fn().mockResolvedValue(null) }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
// `export_sales_summary` es de Pro: el negocio de prueba no tiene plan; el candado no es lo que se prueba aquí.
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.setTimeout(120_000)

type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const TZ = 'America/Mexico_City'
const D = (v: number) => new Prisma.Decimal(v)
const fixtures: Seed[] = []
let n = 0

async function negocio() {
  const s = await seedClothingSale()
  fixtures.push(s)
  await prisma.venue.update({ where: { id: s.venueId }, data: { timezone: TZ } })
  await prisma.customer.update({
    where: { id: s.customer.id },
    data: { phone: `55${String(10_000_000 + ((process.pid * 97 + ++n * 7919 + Date.now()) % 89_999_999)).padStart(8, '0')}` },
  })
  return s
}

const abonarSaldo =
  (staffId: string): AbonarSaldoAFavor =>
  (tx, refundPaymentId, preparado, fila) =>
    abonarSaldoAFavorEnTx(tx, {
      preparado,
      monto: D(fila.montoCents).div(100),
      staffId,
      origen: { orderId: fila.orderId, refundPaymentId },
      folio: refundPaymentId.slice(-6),
      tipo: 'REEMBOLSO',
    })

/** Un saldo a favor de `pesos` abonado OTRO día (la venta en efectivo y su devolución a saldo, dos días atrás). Devuelve el sobre. */
async function saldoDeOtroDia(s: Seed, pesos: number): Promise<string> {
  await prepararMediosDeSaldoAFavor(s.venueId)
  const aSaldo = await issueRefund({
    venueId: s.venueId,
    staffId: s.staffId,
    paymentId: s.payments[0].id,
    amount: pesos * 100,
    reason: 'RETURNED_GOODS',
    aSaldoAFavor: { customerId: s.customer.id, abonar: abonarSaldo(s.staffId) },
  })
  await prisma.payment.updateMany({
    where: { id: { in: [s.payments[0].id, aSaldo.refundId] } },
    data: { createdAt: new Date(Date.now() - 2 * 86_400_000) },
  })
  return aSaldo.abono!.giftCardId
}

const tarjetaVendida = async (s: Seed, pesos: number) =>
  (
    await sembrarVentaDeTarjetas({
      venueId: s.venueId,
      organizationId: s.organizationId,
      staffId: s.staffId,
      montos: [pesos],
      metodo: 'CASH',
    })
  ).giftCardIds[0]

/** Lo que ven el DASHBOARD (desglose y exportación) y el MCP (`export_sales_summary`) del día. */
async function loQueSeVe(s: Seed) {
  const desde = new Date(Date.now() - 3_600_000)
  const hasta = new Date(Date.now() + 3_600_000)
  const reporte = await getSalesSummary(s.venueId, {
    startDate: desde.toISOString(),
    endDate: hasta.toISOString(),
    groupBy: 'paymentMethod',
    timezone: TZ,
  })
  const exportacion = flattenSalesSummaryForExport(reporte, ['paymentMethods']).rows

  const herramientas = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  const scope = {
    staffId: s.staffId,
    activeOrg: s.organizationId,
    scopes: ['mcp:read'],
    allowedVenueIds: [s.venueId],
    perVenueAccess: new Map([[s.venueId, { role: 'OWNER', corePermissions: ['analytics:read'] }]]),
  } as unknown as McpScope
  registerSalesTools({ tool: (...a: unknown[]) => herramientas.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  const hoy = formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd')
  const mcp = JSON.parse(
    (await herramientas.get('export_sales_summary')!({ venueId: s.venueId, fromDate: hoy, toDate: hoy, sections: 'paymentMethods' }, {}))
      .content[0].text,
  ) as { rows: SalesSummaryExportRow[] }
  return { reporte, exportacion, mcp: mcp.rows }
}

/**
 * LA INVARIANTE, sobre todas las filas: (1) el desglose (dinero y ventas) — importe ≠ 0 ⇒ conteo > 0; (2) lo pagado con saldo de
 * tarjetas vendidas — bruto o reverso ≠ 0 ⇒ conteo > 0, y aparece en la barra de ventas y en las dos exportaciones con su bruto y su
 * reverso; (3) cada fila de método de las dos exportaciones — importe ≠ 0 ⇒ conteo > 0.
 */
function revisarLaInvariante({ reporte, exportacion, mcp }: Awaited<ReturnType<typeof loQueSeVe>>) {
  const malas: string[] = []
  for (const m of [...(reporte.byPaymentMethod ?? []), ...(reporte.salesByPaymentMethod ?? [])])
    if (m.amount !== 0 && !(m.count > 0)) malas.push(`desglose ${m.method}: importe ${m.amount} con conteo ${m.count}`)
  const saldo = reporte.giftCardBalanceBreakdown
  if (saldo && (saldo.amount !== 0 || saldo.refunds !== 0)) {
    if (!(saldo.count > 0)) malas.push(`saldo de tarjetas: bruto ${saldo.amount}, reverso ${saldo.refunds} con conteo ${saldo.count}`)
    if (reporte.salesByPaymentMethod && !reporte.salesByPaymentMethod.some(m => m.method === 'GIFT_CARD' && m.count > 0))
      malas.push('barra de ventas: falta GIFT_CARD (con conteo)')
    for (const [quien, filas] of [
      ['exportación del DASHBOARD', exportacion],
      ['export_sales_summary del MCP', mcp],
    ] as const) {
      if (!filas.some(f => f.label === 'Saldo de tarjeta de regalo' && f.amount === saldo.amount && (f.count ?? 0) > 0))
        malas.push(`${quien}: falta «Saldo de tarjeta de regalo» (${saldo.amount}) con conteo`)
      if (saldo.refunds > 0 && !filas.some(f => f.label === 'Regresó al saldo de tarjetas' && f.amount === saldo.refunds))
        malas.push(`${quien}: falta «Regresó al saldo de tarjetas» (${saldo.refunds})`)
    }
  }
  for (const [quien, filas] of [
    ['exportación del DASHBOARD', exportacion],
    ['export_sales_summary del MCP', mcp],
  ] as const)
    for (const f of filas)
      if (f.section === 'paymentMethods' && f.count !== null && f.amount !== 0 && !(f.count > 0))
        malas.push(`${quien} ${f.label}: importe ${f.amount} con conteo ${f.count}`)
  expect(malas).toEqual([])
}

const fila = (r: SalesSummaryResponse, method: string) => r.salesByPaymentMethod?.find(m => m.method === method)

afterAll(async () => {
  for (const s of fixtures) {
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: s.venueId } } })
    await s.cleanup().catch(error => console.warn('invarianteDelDesglose: la limpieza no terminó', String(error)))
  }
  await prisma.$disconnect()
})

describe('🔴 la invariante del desglose por método: importe bruto, reverso o neto ≠ 0 ⇒ conteo > 0 y aparece', () => {
  it('caso de Codex r3: $300 de saldo a favor (de otro día) + $200 de tarjeta vendida en UN cobro de $500, devuelto completo (neto 0)', async () => {
    const s = await negocio()
    const sobre = await saldoDeOtroDia(s, 300)
    const regalada = await tarjetaVendida(s, 200)
    const { pagoConSaldo } = await sembrarCanje({
      venueId: s.venueId,
      staffId: s.staffId,
      giftCardIds: [regalada, sobre],
      total: 500,
      conSaldo: 500,
    })
    await issueRefund({ venueId: s.venueId, paymentId: pagoConSaldo.id, amount: 50000, reason: 'RETURNED_GOODS', staffId: s.staffId })

    const visto = await loQueSeVe(s)
    expect(visto.reporte.giftCardBalanceBreakdown).toMatchObject({ amount: 200, refunds: 200 })
    revisarLaInvariante(visto)
    // Por pata: el cobro cuenta en las dos; la devolución regresa a las dos (la de saldo a favor cuenta en OTHER como fila de ventas).
    expect(fila(visto.reporte, 'GIFT_CARD')).toMatchObject({ amount: 0, count: 1 })
    expect(fila(visto.reporte, 'OTHER')).toMatchObject({ amount: 0, count: 2 })
  })

  it('caso de Codex r2: $200 de saldo a favor (de otro día) como parte MENOR de un cobro de $500 con $300 de tarjeta vendida', async () => {
    const s = await negocio()
    const sobre = await saldoDeOtroDia(s, 200)
    const regalada = await tarjetaVendida(s, 300)
    await sembrarCanje({ venueId: s.venueId, staffId: s.staffId, giftCardIds: [regalada, sobre], total: 500, conSaldo: 500 })

    const visto = await loQueSeVe(s)
    revisarLaInvariante(visto)
    expect(fila(visto.reporte, 'GIFT_CARD')).toMatchObject({ amount: 300, count: 1 })
    expect(fila(visto.reporte, 'OTHER')).toMatchObject({ amount: 200, count: 1 })
    expect(visto.reporte.salesByPaymentMethod?.reduce((suma, m) => suma + m.amount, 0)).toBe(500)
  })

  it('un cobro normal sin saldo (efectivo): una fila, con su conteo', async () => {
    const s = await negocio()
    const visto = await loQueSeVe(s)
    revisarLaInvariante(visto)
    expect(visto.reporte.byPaymentMethod).toEqual([expect.objectContaining({ method: 'CASH', amount: 500, count: 1 })])
    expect(visto.reporte.salesByPaymentMethod).toBeUndefined() // sin tarjetas en el negocio, ventas y dinero son lo mismo
  })

  it('una tarjeta vendida sola: $300 de saldo de regalo en un cobro', async () => {
    const s = await negocio()
    const regalada = await tarjetaVendida(s, 300)
    await sembrarCanje({ venueId: s.venueId, staffId: s.staffId, giftCardIds: [regalada], total: 300, conSaldo: 300 })

    const visto = await loQueSeVe(s)
    revisarLaInvariante(visto)
    expect(visto.reporte.giftCardBalanceBreakdown).toMatchObject({ amount: 300, count: 1, refunds: 0 })
    expect(fila(visto.reporte, 'GIFT_CARD')).toMatchObject({ amount: 300, count: 1 })
    expect(fila(visto.reporte, 'OTHER')).toBeUndefined()
  })
})
