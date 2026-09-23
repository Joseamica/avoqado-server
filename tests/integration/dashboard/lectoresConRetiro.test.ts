/**
 * 🔴 DINERO — lo que el DUEÑO lee después de que el proveedor de reparto retira un renglón
 * (spec KDS Uber §3.1 «Lectores», [N-3][N-9][N-13][N-14]), contra Postgres REAL.
 *
 * El retiro deja el renglón con `removedAt` (se conserva para auditoría) y un REFUND compensatorio
 * con `processorData.provenance = 'PROVIDER_ADJUSTMENT'`. Cada reporte tiene que verlo UNA vez:
 *  - comisiones por tipo de pago: la compensación suma CON SIGNO; el conteo sigue siendo de cobros;
 *    un reembolso MANUAL del dashboard sigue fuera, como hoy;
 *  - venta por artículo: el renglón retirado no cuenta, y la fila REFUND no duplica los que quedan;
 *  - `lineRevenue` (la definición compartida de lo que ganó una línea): una línea retirada vale 0;
 *  - estado de resultados: el IVA de la compensación es el MISMO que posteó la póliza.
 */
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { getTenderCommissionsReport } from '@/services/dashboard/tenderType.dashboard.service'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { lineGrossSql, lineRevenueSql, lineUnitsSql } from '@/services/dashboard/lineRevenue'
import { getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { getMappings, seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { fiscalByRateCents } from '@/services/fiscal/deliveryFiscalDelta'
import { getExtendedMetrics } from '@/services/dashboard/generalStats.dashboard.service'
import { getPMIXReport } from '@/services/dashboard/report.service'
import { SharedQueryService } from '@/services/dashboard/shared-query.service'
import { getPromotionSales } from '@/services/dashboard/promotion-sales.dashboard.service'
import { getCategoryBreakdown } from '@/jobs/nightly-sales-summary.job'
import { registerProductTools } from '@/mcp/tools/products'
import type { McpScope } from '@/mcp/scope'
import { limpiarVenue, sembrarCobro } from './sembrarCobroParaReembolso'

// La tool del MCP se llama directo: el guardia y el plan no son lo que se prueba aquí (tienen sus suites).
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))

jest.setTimeout(120000)

const ayer = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const manana = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
const desde = new Date(Date.now() - 86_400_000)
const hasta = new Date(Date.now() + 86_400_000)

describe('lectores con un renglón retirado por el proveedor', () => {
  let venueId: string
  let organizationId: string
  let rfc: string
  let ordenRetiro: string
  let tenderRetiro: string
  let tenderManual: string
  let ivaCuenta: string
  let producto: { vivo: string; retirado: string }

  beforeAll(async () => {
    const testData = await setupTestData()
    venueId = testData.venue.id
    const staffId = testData.staff[0].id
    organizationId = testData.organization.id
    // El venue nace con 50 cobros aleatorios: se quitan para que los reportes vean SÓLO lo sembrado aquí.
    await limpiarVenue(venueId)
    rfc = `LCR${Date.now().toString(36).toUpperCase().slice(-6)}XX0`
    await prisma.venue.update({ where: { id: venueId }, data: { rfc } })
    const [latte, pan] = testData.products
    producto = { vivo: latte.name, retirado: pan.name }
    await prisma.product.update({ where: { id: latte.id }, data: { taxRate: new Prisma.Decimal('0.16') } })
    await prisma.product.update({ where: { id: pan.id }, data: { taxRate: new Prisma.Decimal('0') } })
    await seedBaseChart(venueId, { staffId })
    await seedDefaultMappings(venueId, { staffId })
    const { mappings } = await getMappings(venueId)
    ivaCuenta = mappings.find(m => m.movementType === 'IVA_OUTPUT')!.account!.id

    // A · pedido de reparto de $200 (Latte $150 al 16 % + Pan de muerto $50 al 0 %) cobrado con un
    // tipo de pago al 30 %. Uber retira el Pan: renglón con removedAt + REFUND compensatorio de $50.
    const a = await sembrarCobro({
      venueId,
      staffId,
      saleCents: 20000,
      commissionPercent: 30,
      items: [
        { productId: latte.id, productName: 'Latte', quantity: 1, totalCents: 15000 },
        { productId: pan.id, productName: 'Pan de muerto', quantity: 1, totalCents: 5000 },
      ],
    })
    ordenRetiro = a.order.id
    tenderRetiro = a.tender!.id
    // El Pan salió dentro de una promoción y con $5 de descuento en su renglón: así los reportes de
    // promociones y los descuentos crudos también tienen algo que NO deben contar.
    const promo = await prisma.promotion.create({ data: { venueId, name: 'Combo retiro', type: 'BUNDLE', pricingMode: 'FIXED_TOTAL' } })
    const op = await prisma.orderPromotion.create({
      data: {
        orderId: a.order.id,
        promotionId: promo.id,
        instanceId: `op-${a.order.id}`,
        snapshotJson: { name: 'Combo retiro' },
        grossCents: 20000,
        discountCents: 500,
        netCents: 19500,
      },
    })
    await prisma.orderItem.update({ where: { id: a.items[0].id }, data: { orderPromotionId: op.id } })
    await prisma.orderItem.update({
      where: { id: a.items[1].id },
      data: { removedAt: new Date(), orderPromotionId: op.id, discountAmount: new Prisma.Decimal(5) },
    })
    const L = (unitPrice: number, taxRate: number) => ({ unitPrice, quantity: 1, discountAmount: 0, taxRate })
    // Retirar lo del 0 % no devuelve IVA ({}); la mezcla de la orden diría 5.17. Distintos a propósito.
    const fiscal = fiscalByRateCents([L(150, 0.16), L(50, 0)], [L(150, 0.16)], 20000, 15000)
    await prisma.$transaction(tx =>
      writeRefundInTx(tx, {
        originalPaymentId: a.pago.id,
        venueId,
        salesRefundCents: 5000,
        tipRefundCents: 0,
        refundedItems: [{ orderItemId: a.items[1].id, quantity: 1, amountCents: 5000 }],
        fiscalByRateCents: fiscal,
        reason: 'DELIVERY_ITEM_REMOVED',
        staffId: null,
        idempotencyKey: `dlr:${a.order.id}:1`,
        tenderCommission: 'REVERSE_PROPORTIONAL',
        shift: 'INHERIT_ORIGINAL',
        provenance: 'PROVIDER_ADJUSTMENT',
        generation: 1,
      }),
    )

    // B · cobro de $200 al 30 % con un reembolso MANUAL de $50 desde el dashboard.
    const b = await sembrarCobro({ venueId, staffId, saleCents: 20000, commissionPercent: 30 })
    tenderManual = b.tender!.id
    await issueRefund({ venueId, paymentId: b.pago.id, amount: 5000, reason: 'OTHER', staffId })

    await generatePoliciesForVenue(venueId)
  })

  afterAll(async () => {
    await prisma.journalEntry.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
    await prisma.accountMapping.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
    await prisma.ledgerAccount.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
    await limpiarVenue(venueId)
    await prisma.promotion.deleteMany({ where: { venueId } }).catch(() => undefined)
    await teardownTestData().catch(() => undefined)
  })

  it('el reporte de tender suma la compensacion del proveedor con signo; el conteo es de cobros', async () => {
    const r = await getTenderCommissionsReport(venueId, { from: ayer, to: manana })
    expect(r.rows.find(x => x.tenderTypeId === tenderRetiro)).toMatchObject({ count: 1, gross: 150, commission: 45, net: 105 })
  })

  it('un reembolso MANUAL del dashboard sigue EXCLUIDO del reporte', async () => {
    const r = await getTenderCommissionsReport(venueId, { from: ayer, to: manana })
    expect(r.rows.find(x => x.tenderTypeId === tenderManual)).toMatchObject({ count: 1, gross: 200, commission: 60, net: 140 })
  })

  it('sales-by-item por metodo NO duplica la linea superviviente cuando hay un REFUND', async () => {
    const r = await getSalesByItem(venueId, { startDate: ayer, endDate: manana, groupBy: 'paymentMethod' })
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ grossSales: 150, itemsSold: 1, unitsSold: 1 })
  })

  it('sales-by-item no cuenta el producto retirado (tabla y grafica)', async () => {
    const r = await getSalesByItem(venueId, { startDate: ayer, endDate: manana, groupBy: 'none', reportType: 'days' })
    expect(r.items.find(x => x.productName === 'Pan de muerto')).toBeUndefined()
    expect(r.items.find(x => x.productName === 'Latte')).toMatchObject({ grossSales: 150, unitsSold: 1 })
    expect(r.totals).toMatchObject({ itemsSold: 1, unitsSold: 1, grossSales: 150 })
    expect(r.byPeriod!.reduce((s, p) => s + p.grossSales, 0)).toBe(150)
    expect(r.byPeriod!.reduce((s, p) => s + p.itemsSold, 0)).toBe(1)
  })

  it('lineRevenue: una linea retirada vale 0 (unidades, bruto y neto)', async () => {
    const [fila] = await prisma.$queryRawUnsafe<Array<{ unidades: number; bruto: number; neto: number }>>(
      `SELECT SUM(${lineUnitsSql()})::float AS unidades, SUM(${lineGrossSql()})::float AS bruto, SUM(${lineRevenueSql()})::float AS neto
         FROM "OrderItem" oi WHERE oi."orderId" = $1`,
      ordenRetiro,
    )
    expect(fila).toEqual({ unidades: 1, bruto: 150, neto: 150 })
  })

  it('estado de resultados: el IVA de la compensacion es el que posteo la poliza', async () => {
    const lineas = await prisma.journalLine.findMany({
      where: { ledgerAccountId: ivaCuenta, journalEntry: { organizationId, rfc } },
      select: { debitCents: true, creditCents: true },
    })
    const ivaDelDiario = lineas.reduce((s, l) => s + l.creditCents - l.debitCents, 0)
    const e = await getIncomeStatement(venueId, { from: ayer, to: manana })
    expect(e.revenue.ivaCents).toBe(ivaDelDiario)
    expect(e.fiscalRevenue.ivaCents).toBe(ivaDelDiario)
    // Todo el IVA es del 16 % (el Pan era 0 % y B no tiene renglones): su única llave es el diario.
    expect(e.revenue.taxByRate).toEqual({ '0.16': ivaDelDiario })
  })

  // ── Cada familia de consultas por renglón: el retirado no aporta unidades, costo, descuento ni venta ──

  it('productos (generalStats): el retirado no aparece; el vivo cuenta 1 unidad', async () => {
    const filas = (await getExtendedMetrics(venueId, 'product-profitability', {
      fromDate: desde.toISOString(),
      toDate: hasta.toISOString(),
    })) as Array<{ name: string; quantity: number; totalRevenue: number }>
    expect(filas.find(f => f.name === producto.retirado)).toBeUndefined()
    expect(filas.find(f => f.name === producto.vivo)).toMatchObject({ quantity: 1, totalRevenue: 150 })
  })

  it('PMIX (report.service): el retirado no suma unidades ni al total', async () => {
    const r = await getPMIXReport(venueId, desde, hasta)
    expect(r.products.find(p => p.productName === producto.retirado)).toBeUndefined()
    expect(r.summary).toMatchObject({ totalQuantitySold: 1, totalRevenue: 150 })
  })

  it('correo nocturno (categorias): el retirado no suma articulos', async () => {
    expect(await getCategoryBreakdown(venueId, desde, hasta)).toEqual([{ name: 'Test Menu', itemsSold: 1, netSales: 150 }])
  })

  it('top de productos (shared-query): el retirado no aparece', async () => {
    const top = await SharedQueryService.getTopProducts(venueId, { from: desde, to: hasta })
    expect(top.find(p => p.productName === producto.retirado)).toBeUndefined()
    expect(top.find(p => p.productName === producto.vivo)).toMatchObject({ quantitySold: 1, revenue: 150 })
  })

  it('MCP product_sales: el retirado vale 0 unidades, 0 venta y 0 veces pedido', async () => {
    const tools = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
    const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: [venueId], perVenueAccess: new Map() } as McpScope
    registerProductTools({ tool: (...a: unknown[]) => tools.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
    const r = await tools.get('product_sales')!({ venueId, name: producto.retirado, fromDate: ayer, toDate: manana }, {})
    expect(JSON.parse(r.content[0].text)).toMatchObject({ found: true, unitsSold: 0, revenue: 0, timesOrdered: 0 })
  })

  it('promociones: el renglon retirado no aporta bruto, descuento ni neto', async () => {
    const r = await getPromotionSales(venueId, { startDate: ayer, endDate: manana, reportType: 'days' })
    expect(r.promotions).toHaveLength(1)
    expect(r.promotions[0]).toMatchObject({ timesSold: 1, grossSales: 150, discounts: 0, netSales: 150 })
    expect(r.byPeriod!.reduce((s, p) => s + p.discounts, 0)).toBe(0)
    expect(r.byPeriod!.reduce((s, p) => s + p.grossSales, 0)).toBe(150)
  })
})
