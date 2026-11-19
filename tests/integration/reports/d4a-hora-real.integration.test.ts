/**
 * D4 fase 4a (REAL PostgreSQL · hz:47b359b5:D4, tras D93, D1 y D2): las herramientas de IA y los reportes del negocio que faltaban cuentan
 * lo vendido sin internet a su hora real, igual que el Resumen de ventas.
 *
 * Negocio A (fechas fijas, CDMX): la Playera S vendida sin internet a las 23:50 del 11 y subida a las 00:10 del 12 guarda `createdAt` =
 * 00:10 (la llegada) y `clientCreatedAt` = 23:50, en la orden y en su cobro. Lleva un combo, un descuento y un extra: sale el 11 en
 * Promociones, Descuentos aplicados, PMIX, uso de extras, los reportes históricos de la TPV y `product_variants`; el 12 no.
 * Negocio B (relativo a «ahora», que la prueba fija a las 12:00 del 18 en CDMX para no depender de la hora en que corre):
 * `today_overview`, `sales_comparison`, `revenue_by_venue` y `promotion_status`. Regla de toda la fase: lo de una cuenta cuenta en el día
 * de la cuenta (su hora real), como Promociones, PMIX y Ventas por artículo.
 * Variación de costo se queda a propósito con la llegada: su lado real son movimientos de inventario fechados a la llegada.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern d4a-hora-real
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))

import prisma from '@/utils/prismaClient'
import { venueEndOfDay, venueStartOfDay } from '@/utils/datetime'
import { getPromotionSales } from '@/services/dashboard/promotion-sales.dashboard.service'
import { listarDescuentosAplicados } from '@/services/dashboard/descuentosAplicados.service'
import { getPMIXReport } from '@/services/dashboard/report.service'
import { getModifierUsageStats } from '@/services/dashboard/modifierInventoryAnalytics.service'
import { getHistoricalSummaries, HistoricalGrouping } from '@/services/tpv/historical-reports.service'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'
import { createProductWithVariants } from '@/services/product-variants/productGroup.service'
import { registerProductVariantTools } from '@/mcp/tools/productVariants'
import { registerOverviewTools } from '@/mcp/tools/overview'
import { registerTrendTools } from '@/mcp/tools/trends'
import { registerPromotionTools } from '@/mcp/tools/promotions'
import type { McpScope } from '@/mcp/scope'
import { crearNegocio, NegocioDePrueba } from '../product-variants/fixtures'

const TZ = 'America/Mexico_City'
const DIA_11 = { from: new Date('2026-11-11T06:00:00.000Z'), to: new Date('2026-11-12T05:59:59.999Z') }
const DIA_12 = { from: new Date('2026-11-12T06:00:00.000Z'), to: new Date('2026-11-13T05:59:59.999Z') }
const CAFE = new Date('2026-11-12T00:00:00.000Z') // 18:00 del 11, con red
const PLAYERA_DEL_APARATO = new Date('2026-11-12T05:50:00.000Z') // 23:50 del 11
const PLAYERA_LLEGADA = new Date('2026-11-12T06:10:00.000Z') // 00:10 del 12
const JUGO = new Date('2026-11-12T16:00:00.000Z') // 10:00 del 12, con red
const HORA = 60 * 60 * 1000
const AHORA = new Date('2026-11-18T18:00:00.000Z') // 12:00 del 18 en CDMX: sólo el reloj (Date) es falso, los timers son reales
const dia = (d: Date | string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d))

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const ia = async (name: string, args: Record<string, unknown>) => JSON.parse((await handlers.get(name)!(args, {})).content[0].text)

let n: NegocioDePrueba
let venueB: string
let tallaS: string
let promoA: string
let promoB: string
let promoC: string
let extra: string
let ed: string
let seq = 0

async function venta(p: {
  venueId: string
  productId: string | null
  nombre: string
  monto: number
  llegada: Date
  delAparato?: Date
  promocion?: string
  descuento?: number
  conExtra?: boolean
  /** La hora del renglón del combo, si no es la llegada (una mesa con red que agrega el combo después). */
  renglonDelCombo?: Date
  sinCobro?: boolean
}): Promise<string> {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId: p.venueId,
      orderNumber: `D4A-${seq}-${n.venueId}`,
      createdById: n.staffId,
      createdAt: p.llegada,
      clientCreatedAt: p.delAparato ?? null,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: p.monto,
      taxAmount: 0,
      discountAmount: 0,
      tipAmount: 0,
      total: p.monto,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      items: { create: [{ productId: p.productId, productName: p.nombre, quantity: 1, unitPrice: p.monto, taxAmount: 0, total: p.monto }] },
    },
    select: { id: true, items: { select: { id: true } } },
  })
  if (!p.sinCobro)
    await prisma.payment.create({
      data: {
        venueId: p.venueId,
        orderId: order.id,
        amount: p.monto,
        tipAmount: 0,
        method: 'CASH',
        status: 'COMPLETED',
        type: 'REGULAR',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: p.monto,
        createdAt: p.llegada,
        clientCreatedAt: p.delAparato ?? null,
      },
    })
  if (p.promocion) {
    // El renglón del combo nace con la LLEGADA, como el de una venta de la cola.
    const op = await prisma.orderPromotion.create({
      data: {
        orderId: order.id,
        promotionId: p.promocion,
        instanceId: `inst-${seq}-${n.venueId}`,
        snapshotJson: { name: 'Combo' },
        grossCents: p.monto * 100,
        discountCents: 0,
        netCents: p.monto * 100,
        createdAt: p.renglonDelCombo ?? p.llegada,
      },
      select: { id: true },
    })
    await prisma.orderItem.update({ where: { id: order.items[0].id }, data: { orderPromotionId: op.id } })
  }
  if (p.descuento)
    await prisma.orderDiscount.create({
      data: {
        orderId: order.id,
        type: 'FIXED_AMOUNT',
        name: 'Cortesía',
        value: p.descuento,
        amount: p.descuento,
        createdAt: p.llegada,
      } as never,
    })
  if (p.conExtra)
    await prisma.orderItemModifier.create({ data: { orderItemId: order.items[0].id, modifierId: extra, price: 0, quantity: 1 } as never })
  return order.id
}

beforeAll(async () => {
  jest.useFakeTimers({
    now: AHORA,
    advanceTimers: true,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  })
  n = await crearNegocio('d4a-hora-real')
  await prisma.venue.update({ where: { id: n.venueId }, data: { timezone: TZ } })
  venueB = (
    await prisma.venue.create({
      data: {
        organizationId: n.organizationId,
        name: `d4a-b-${n.venueId}`,
        slug: `d4a-b-${n.venueId}`,
        timezone: TZ,
        seatCapExempt: true,
      } as never,
      select: { id: true },
    })
  ).id
  const familia = await createProductWithVariants(
    n.venueId,
    {
      name: 'Playera',
      categoryId: n.categoryId,
      options: [{ name: 'Talla', values: ['S', 'M'] }],
      variants: [
        { values: ['S'], price: 50 },
        { values: ['M'], price: 60 },
      ],
    },
    n.actor,
  )
  tallaS = familia.productIds[0]
  const cafe = await prisma.product.create({
    data: { venueId: n.venueId, categoryId: n.categoryId, sku: `CAFE-${n.venueId}`, name: 'Café', price: 100 },
  })
  const jugo = await prisma.product.create({
    data: { venueId: n.venueId, categoryId: n.categoryId, sku: `JUGO-${n.venueId}`, name: 'Jugo', price: 30 },
  })
  promoA = (
    await prisma.promotion.create({
      data: { venueId: n.venueId, name: 'Combo A', type: 'COMBO', pricingMode: 'FIXED_TOTAL' },
      select: { id: true },
    })
  ).id
  const grupo = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: 'Extras' }, select: { id: true } })
  extra = (await prisma.modifier.create({ data: { groupId: grupo.id, name: 'Queso' }, select: { id: true } })).id

  // Negocio A, fechas fijas.
  await venta({ venueId: n.venueId, productId: cafe.id, nombre: 'Café', monto: 100, llegada: CAFE })
  await venta({
    venueId: n.venueId,
    productId: tallaS,
    nombre: 'Playera · S',
    monto: 50,
    llegada: PLAYERA_LLEGADA,
    delAparato: PLAYERA_DEL_APARATO,
    promocion: promoA,
    descuento: 5,
    conExtra: true,
  })
  await venta({ venueId: n.venueId, productId: jugo.id, nombre: 'Jugo', monto: 30, llegada: JUGO })
  // Ed: sin internet a las 23:50 del 13, subida a las 00:10:43 del 14; luego un superadmin corrige su fecha al 15.
  ed = await venta({
    venueId: n.venueId,
    productId: null,
    nombre: 'Ed',
    monto: 20,
    llegada: new Date('2026-11-14T06:10:43.252Z'),
    delAparato: new Date('2026-11-14T05:50:00.000Z'),
  })
  // Borde del comparativo histórico: Té con red en el ÚLTIMO milisegundo del 9; Pan con red el 10.
  await venta({ venueId: n.venueId, productId: null, nombre: 'Té', monto: 2, llegada: new Date('2026-11-10T05:59:59.999Z') })
  await venta({ venueId: n.venueId, productId: null, nombre: 'Pan', monto: 4, llegada: new Date('2026-11-10T18:00:00.000Z') })
  // Una venta fechada a futuro (a mano), con el extra: un rango con sólo «desde» la alcanza, como antes.
  await venta({
    venueId: n.venueId,
    productId: null,
    nombre: 'Futuro',
    monto: 3,
    llegada: new Date('2030-01-01T18:00:00.000Z'),
    conExtra: true,
  })

  // Negocio B, relativo a ahora: X con red hace 2 h; Y sin internet hace 25 h, subida hace 23 h; Z sin internet 10 min antes de que
  // empezara HOY, subida 1 s después (con la llegada, Z era de hoy); W con red, una mesa abierta ayer a la misma hora que Z a la que
  // HOY le agregaron el combo B; V con red, una cuenta de hoy con el combo C. W y V sin cobrar todavía.
  promoB = (
    await prisma.promotion.create({
      data: { venueId: venueB, name: 'Combo B', type: 'COMBO', pricingMode: 'FIXED_TOTAL', status: 'PUBLISHED' } as never,
      select: { id: true },
    })
  ).id
  const ahora = Date.now()
  const inicioDeHoy = venueStartOfDay(TZ).getTime()
  const antesDeHoy = 10 * 60 * 1000
  await venta({ venueId: venueB, productId: null, nombre: 'X', monto: 10, llegada: new Date(ahora - 2 * HORA) })
  await venta({
    venueId: venueB,
    productId: null,
    nombre: 'Y',
    monto: 50,
    llegada: new Date(ahora - 23 * HORA),
    delAparato: new Date(ahora - 25 * HORA),
  })
  await venta({
    venueId: venueB,
    productId: null,
    nombre: 'Z',
    monto: 7,
    llegada: new Date(inicioDeHoy + 1000),
    delAparato: new Date(inicioDeHoy - antesDeHoy),
    promocion: promoB,
  })
  await venta({
    venueId: venueB,
    productId: null,
    nombre: 'W',
    monto: 9,
    llegada: new Date(inicioDeHoy - antesDeHoy),
    renglonDelCombo: new Date(inicioDeHoy + 1000),
    promocion: promoB,
    sinCobro: true,
  })
  promoC = (
    await prisma.promotion.create({
      data: { venueId: venueB, name: 'Combo C', type: 'COMBO', pricingMode: 'FIXED_TOTAL', status: 'PUBLISHED' } as never,
      select: { id: true },
    })
  ).id
  await venta({
    venueId: venueB,
    productId: null,
    nombre: 'V',
    monto: 8,
    llegada: new Date(ahora - HORA),
    promocion: promoC,
    sinCobro: true,
  })

  const scope = {
    staffId: n.staffId,
    activeOrg: n.organizationId,
    allowedVenueIds: [n.venueId, venueB],
    scopes: ['mcp:read'],
    perVenueAccess: new Map([
      [n.venueId, { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }],
      [venueB, { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }],
    ]),
  } as unknown as McpScope
  const reg = { tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as Handler) } as never
  registerProductVariantTools(reg, scope)
  registerOverviewTools(reg, scope)
  registerTrendTools(reg, scope)
  registerPromotionTools(reg, scope)
})

afterAll(async () => {
  const venues = [n?.venueId, venueB].filter(Boolean) as string[]
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId: { in: venues } } } } })
  await prisma.orderDiscount.deleteMany({ where: { order: { venueId: { in: venues } } } })
  await prisma.orderItem.updateMany({ where: { order: { venueId: { in: venues } } }, data: { orderPromotionId: null } })
  await prisma.orderPromotion.deleteMany({ where: { order: { venueId: { in: venues } } } })
  await prisma.payment.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId: { in: venues } } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.promotion.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.modifier.deleteMany({ where: { group: { venueId: n.venueId } } })
  await prisma.modifierGroup.deleteMany({ where: { venueId: n.venueId } })
  if (venueB) await prisma.venue.deleteMany({ where: { id: venueB } })
  await n?.limpiar()
  await prisma.$disconnect()
  jest.useRealTimers()
})

describe('D4a · reportes del negocio a la hora real', () => {
  it('Promociones: el combo de la Playera sale el 11, no el 12 (como Ventas por artículo)', async () => {
    const pedir = (d: typeof DIA_11) =>
      getPromotionSales(n.venueId, { startDate: d.from.toISOString(), endDate: d.to.toISOString(), reportType: 'days', timezone: TZ })
    const r11 = await pedir(DIA_11)
    expect(r11.totals.timesSold).toBe(1)
    expect(r11.byPeriod?.map(p => [p.period.slice(0, 10), p.timesSold])).toEqual([['2026-11-11', 1]])
    expect((await pedir(DIA_12)).totals.timesSold).toBe(0)
    // Mismo día que Ventas por artículo (D1).
    const articulos = async (d: typeof DIA_11) =>
      (await getSalesByItem(n.venueId, { startDate: d.from.toISOString(), endDate: d.to.toISOString(), timezone: TZ })).items.map(
        i => i.productId,
      )
    expect(await articulos(DIA_11)).toContain(tallaS)
    expect(await articulos(DIA_12)).not.toContain(tallaS)
  })

  it('Descuentos aplicados: el de la Playera cuenta el 11', async () => {
    const r11 = await listarDescuentosAplicados(n.venueId, { from: '2026-11-11', to: '2026-11-11' })
    expect(r11.totales.count).toBe(1)
    expect(r11.rows).toHaveLength(1)
    // La fecha que se ve es la de la venta (la que filtró), no la llegada del 12.
    expect(r11.rows[0].createdAt).toEqual(PLAYERA_DEL_APARATO)
    expect((await listarDescuentosAplicados(n.venueId, { from: '2026-11-12', to: '2026-11-12' })).totales.count).toBe(0)
  })

  it('PMIX: el 11 trae Café y Playera · S ($150); el 12 sólo Jugo', async () => {
    const r11 = await getPMIXReport(n.venueId, DIA_11.from, DIA_11.to)
    expect(r11.summary.totalRevenue).toBe(150)
    expect(r11.products.map(p => p.productId).sort()).toEqual([tallaS, r11.products.find(p => p.productId !== tallaS)!.productId].sort())
    const r12 = await getPMIXReport(n.venueId, DIA_12.from, DIA_12.to)
    expect(r12.summary.totalRevenue).toBe(30)
  })

  it('uso de extras: el queso de la Playera cuenta el 11', async () => {
    const u11 = await getModifierUsageStats(n.venueId, { startDate: DIA_11.from, endDate: DIA_11.to })
    expect(u11.find(u => u.modifierId === extra)?.timesUsed).toBe(1)
    const u12 = await getModifierUsageStats(n.venueId, { startDate: DIA_12.from, endDate: DIA_12.to })
    expect(u12.find(u => u.modifierId === extra)).toBeUndefined()
    // Con sólo «desde» el 12: la Playera ya no (es del 11) y el otro extremo sigue abierto, como antes: entra la de 2030.
    // Con la llegada serían 2; con un tope en «ahora», ninguna.
    expect((await getModifierUsageStats(n.venueId, { startDate: DIA_12.from })).find(u => u.modifierId === extra)?.timesUsed).toBe(1)
  })

  it('reportes históricos de la TPV: el 11 suma $150 en 2 órdenes; el 12, $30', async () => {
    const r = await getHistoricalSummaries(n.venueId, HistoricalGrouping.DAILY, DIA_11.from, DIA_12.to, undefined, 10)
    expect(r.periods.map(p => [dia(p.periodStart), p.totalSales, p.totalOrders])).toEqual([
      ['2026-11-12', 30, 1],
      ['2026-11-11', 150, 2],
    ])
    // Pidiendo sólo el 12, su comparativo es el 11 completo ($150, con la Playera): -80 %. Con la llegada, $100 y -70 %.
    const s12 = await getHistoricalSummaries(n.venueId, HistoricalGrouping.DAILY, DIA_12.from, DIA_12.to, undefined, 10)
    expect(s12.periods[0].salesChange).toBeCloseTo(-80, 5)
    // El comparativo del 10 incluye el último milisegundo del 9 (Té, $2): +100 %. Sin él, no habría con qué comparar (null).
    const s10 = await getHistoricalSummaries(
      n.venueId,
      HistoricalGrouping.DAILY,
      new Date('2026-11-10T06:00:00.000Z'),
      new Date('2026-11-11T05:59:59.999Z'),
      undefined,
      10,
    )
    expect(s10.periods.map(p => [dia(p.periodStart), p.totalSales, p.salesChange])).toEqual([['2026-11-10', 4, 100]])
  })

  it('corregir la fecha a mano manda: la venta sin red pasa al día nuevo (antes no salía en ninguno)', async () => {
    // Reenviarla recortada a minutos, como el formulario del DASHBOARD en cada guardado, no es corregirla: no toca la hora del aparato.
    await updateOrder(n.venueId, ed, { createdAt: '2026-11-14T06:10:00.000Z', customerName: 'Ed' } as never)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ed } })).clientCreatedAt).toEqual(new Date('2026-11-14T05:50:00.000Z'))
    await updateOrder(n.venueId, ed, { createdAt: new Date('2026-11-15T18:00:00.000Z') } as never)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ed } })).clientCreatedAt).toBeNull()
    const r = await getHistoricalSummaries(
      n.venueId,
      HistoricalGrouping.DAILY,
      new Date('2026-11-13T06:00:00.000Z'),
      new Date('2026-11-16T05:59:59.999Z'),
      undefined,
      10,
    )
    expect(r.periods.map(p => [dia(p.periodStart), p.totalSales])).toEqual([['2026-11-15', 20]])
  })

  it('product_variants: la talla S se vendió el 11, no el 12', async () => {
    const r11 = await ia('product_variants', { venueId: n.venueId, name: 'Playera', fromDate: '2026-11-11', toDate: '2026-11-11' })
    expect(r11.sales.byVariant.find((v: { name: string }) => v.name === 'Playera · S').unitsSold).toBe(1)
    const r12 = await ia('product_variants', { venueId: n.venueId, name: 'Playera', fromDate: '2026-11-12', toDate: '2026-11-12' })
    expect(r12.sales.unitsSold).toBe(0)
  })
})

describe('D4a · herramientas de IA relativas a hoy', () => {
  it('today_overview: Z (de ayer, subida hoy) ya no cuenta hoy', async () => {
    const inicio = venueStartOfDay(TZ).getTime()
    const fin = venueEndOfDay(TZ).getTime()
    const ahora = Date.now()
    const z = await prisma.order.findFirstOrThrow({ where: { venueId: venueB, total: 7 }, select: { clientCreatedAt: true } })
    const reales = [
      { monto: 10, t: ahora - 2 * HORA },
      { monto: 50, t: ahora - 25 * HORA },
      { monto: 7, t: z.clientCreatedAt!.getTime() },
    ]
    const llegadas = [
      { monto: 10, t: ahora - 2 * HORA },
      { monto: 50, t: ahora - 23 * HORA },
      { monto: 7, t: inicio + 1000 },
    ]
    const hoy = (vs: Array<{ monto: number; t: number }>) => vs.filter(v => v.t >= inicio && v.t <= fin).reduce((s, v) => s + v.monto, 0)
    const r = await ia('today_overview', { venueId: venueB })
    expect(r.salesToday.gross).toBeCloseTo(hoy(reales), 2)
    // Con la llegada, Z (subida 1 s después de empezar hoy) habría contado: la prueba distingue los dos relojes.
    expect(hoy(llegadas)).not.toBe(hoy(reales))
  })

  it('sales_comparison de 1 día: Y (hace 25 h, subida hace 23 h) cae en el periodo anterior', async () => {
    const r = await ia('sales_comparison', { venueId: venueB, days: 1 })
    // Actual (últimas 24 h reales): X y Z. Con la llegada también contaba Y (67).
    expect(r.current.gross).toBeCloseTo(10 + 7, 2)
    expect(r.previous.gross).toBeCloseTo(50, 2)
  })

  it('revenue_by_venue de 1 día: el negocio B suma sólo lo de las últimas 24 h reales', async () => {
    const r = await ia('revenue_by_venue', { days: 1 })
    const filaB = r.venues.find((v: { venueId: string }) => v.venueId === venueB)
    expect(filaB.gross).toBeCloseTo(10 + 7, 2) // con la llegada, 67
    // Sólo «desde», como antes: lo fechado a futuro también entra (negocio A: la de 2030, $3; con un tope en «ahora», 0).
    expect(r.venues.find((v: { venueId: string }) => v.venueId === n.venueId).gross).toBeCloseTo(3, 2)
  })

  it('promotion_status cuenta en el día de la cuenta: Z y W (cuentas de ayer) no son de hoy; V sí', async () => {
    const r = await ia('promotion_status', { venueId: venueB })
    const vendidos = (id: string) => r.activeNow.find((p: { id: string }) => p.id === id)?.soldToday
    // Por la hora del renglón (antes): B = 2 (Z y W se subieron o agregaron hoy). Por el día de la cuenta, como Promociones: 0.
    expect(vendidos(promoB)).toBe(0)
    expect(vendidos(promoC)).toBe(1)
  })
})
