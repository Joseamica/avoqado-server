/**
 * B5 · spec §7: tres cifras separadas en Ventas, e Inicio diciendo lo mismo que el reporte.
 *   mercancía vendida  = $300 en efectivo + $200 pagados con saldo = $500
 *   tarjetas cargadas  = $500 (vigente) + $300 (cancelada y devuelta) − $300 = $500
 *   pagado con saldo   = $200 (ya incluido en la mercancía)
 * Y contra Postgres REAL lo que una prueba unitaria no ve (Prisma valida el `where` al correr): el turno abierto, el resumen de
 * turnos, el cierre y los agregados del MCP excluyen la venta de tarjetas con consultas que de verdad corren.
 *
 * Cada `describe` usa su PROPIO negocio (`crearNegocioDePrueba`), nunca `setupTestData()` (ver `sembrarTarjetasDeRegalo.ts`).
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects=integration --runInBand \
 *   --runTestsByPath tests/integration/giftCards/ventas.integration.test.ts
 */
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
// `sales_by_payment_method` es de Pro: el negocio de prueba no tiene plan; el candado no es lo que se prueba aquí.
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
// Lo mismo para `sales_comparison` y `revenue_by_venue`: piden ADVANCED_REPORTS por lote (`venuesWithFeatureAccess`). El resto del servicio de
// planes se queda real (lo usan los cobros con saldo), salvo para los negocios de `mockConPlan` (1b S1: venden por `createGiftCardOrder`).
const mockConPlan = new Set<string>()
jest.mock('@/services/access/basePlan.service', () => {
  const real = jest.requireActual('@/services/access/basePlan.service')
  return {
    ...real,
    venuesWithFeatureAccess: jest.fn(async (ids: string[]) => new Set(ids)),
    venueHasFeatureAccess: jest.fn((venueId: string, ...resto: unknown[]) =>
      mockConPlan.has(venueId) ? Promise.resolve(true) : real.venueHasFeatureAccess(venueId, ...resto),
    ),
  }
})

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getGiftCardDetail } from '@/services/giftCards/giftCardReports.service'
import { getBasicMetricsData } from '@/services/dashboard/generalStats.dashboard.service'
import {
  aggregateShiftPayments,
  closeShiftForVenueWithResult,
  getCurrentShift,
  getShiftsSummary,
  readShiftPaymentsForClose,
} from '@/services/tpv/shift.tpv.service'
import { aggregateGiftCardLoads, aggregatePaymentsByMethod } from '@/services/legacy/mergedPayments.service'
import { registerSalesTools } from '@/mcp/tools/sales'
import { registerOverviewTools } from '@/mcp/tools/overview'
import { registerTrendTools } from '@/mcp/tools/trends'
import { registerPaymentTools } from '@/mcp/tools/payments'
import { registerShiftTools } from '@/mcp/tools/shifts'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { createGiftCardOrder, type CreateGiftCardOrderInput } from '@/services/giftCards/giftCardOrder.service'
import { createOrder as venderPorElController } from '@/controllers/mobile/giftCard.mobile.controller'
import { operarSobreDeGerente } from '@/services/giftCards/giftCardSurface.service'
import { cambiarDestinoDeTarjeta } from '@/services/giftCards/giftCardCuenta.service'
import {
  getShiftById as detalleDelTurnoDelPanel,
  getShifts as turnosDelPanel,
  getShiftsSummary as resumenDeTurnosDelPanel,
} from '@/services/dashboard/shift.dashboard.service'
import type { McpScope } from '@/mcp/scope'
import { abrirTurno, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'
import {
  crearCuentaDeMercancia,
  crearNegocioDePrueba,
  limpiarNegocioDePrueba,
  sembrarCanje,
  sembrarVentaDeTarjetas,
  sembrarVentaDeTarjetasSinPagar,
} from './sembrarTarjetasDeRegalo'

jest.setTimeout(60000)

const D = (pesos: number) => new Prisma.Decimal(pesos)

/** Un `REFUND` completado de la terminal sobre un cobro (convención canónica: monto negativo, COMPLETED, REFUND). */
async function devolverConTerminal(p: { venueId: string; orderId: string; staffId: string; monto: number; originalPaymentId: string }) {
  return prisma.payment.create({
    data: {
      venueId: p.venueId,
      orderId: p.orderId,
      amount: D(-p.monto),
      tipAmount: D(0),
      netAmount: D(-p.monto),
      feePercentage: 0,
      feeAmount: D(0),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      type: 'REFUND',
      splitType: 'FULLPAYMENT',
      source: 'TPV',
      processedById: p.staffId,
      processorData: { originalPaymentId: p.originalPaymentId },
    },
  })
}

describe('B5 · ventas con tarjetas de regalo', () => {
  let venueId: string
  let rango: { startDate: string; endDate: string }

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('ventas')
    venueId = negocio.venueId
    const { staffId, organizationId } = negocio
    rango = { startDate: new Date(Date.now() - 60 * 60_000).toISOString(), endDate: new Date(Date.now() + 60 * 60_000).toISOString() }

    await sembrarCobro({ venueId, staffId, saleCents: 30000 })
    const vigente = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CREDIT_CARD' })
    await sembrarCanje({ venueId, staffId, giftCardIds: vigente.giftCardIds, total: 200, conSaldo: 200 })
    const cancelada = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [300], metodo: 'CREDIT_CARD' })
    await devolverConTerminal({ venueId, orderId: cancelada.orderId, staffId, monto: 300, originalPaymentId: cancelada.pagos[0].id })
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('🔴 la mercancía vendida excluye las cuentas de tarjetas; tarjetas cargadas y pagado con saldo van aparte', async () => {
    const r = await getSalesSummary(venueId, { ...rango, groupBy: 'paymentMethod', timezone: 'America/Mexico_City' })
    expect(r.summary.grossSales).toBe(500)
    expect(r.summary.refunds).toBe(0)
    expect(r.summary.netSales).toBe(500)
    expect(r.summary.giftCardLoads).toBe(500)
    expect(r.summary.giftCardLoadsCount).toBe(2)
    expect(r.summary.paidWithGiftCardBalance).toBe(200)
    // r1 (M-2): los cobros, como las ventas brutas, sin los de cuentas de tarjetas: el efectivo y el pagado con saldo.
    expect(r.summary.transactionCount).toBe(2)
  })

  it('🔴 el desglose por método no mezcla el saldo con OTHER y no trae buckets nuevos (el dashboard viejo no se cae)', async () => {
    const r = await getSalesSummary(venueId, { ...rango, groupBy: 'paymentMethod', timezone: 'America/Mexico_City' })
    expect(r.byPaymentMethod?.find(m => m.method === 'OTHER')).toBeUndefined()
    expect(r.byPaymentMethod?.find(m => m.method === 'CREDIT_CARD')?.amount).toBe(500)
    expect(r.byPaymentMethod?.find(m => m.method === 'CASH')?.amount).toBe(300)
    expect(r.byPaymentMethodDetailed?.map(b => b.bucket).sort()).toEqual(['CARD', 'CASH'])
    expect(r.giftCardBalanceBreakdown).toEqual({ amount: 200, count: 1, tips: 0, refunds: 0 })
  })

  it('🔴 full-testing v2 #1 · «ventas por método» (la barra bajo el total): sin las cargas y con el saldo como GIFT_CARD', async () => {
    const r = await getSalesSummary(venueId, { ...rango, groupBy: 'paymentMethod', timezone: 'America/Mexico_City' })
    const filas = (r.salesByPaymentMethod ?? []).map(m => [m.method, m.amount, m.count]).sort()
    // $300 en efectivo + $200 con saldo = lo vendido; la tarjeta de $500 y la cancelada (con su REFUND) son cargas, no ventas.
    expect(filas).toEqual([
      ['CASH', 300, 1],
      ['GIFT_CARD', 200, 1],
    ])
    expect((r.salesByPaymentMethod ?? []).reduce((s, m) => s + m.percentage, 0)).toBeCloseTo(100)
    // El «dinero» por método (B5) no cambia: la carga con tarjeta sigue ahí.
    expect(r.byPaymentMethod?.find(m => m.method === 'CREDIT_CARD')?.amount).toBe(500)
  })

  it('las barras por día suman lo mismo que la cabecera', async () => {
    const r = await getSalesSummary(venueId, { ...rango, reportType: 'days', timezone: 'America/Mexico_City' })
    const suma = (r.byPeriod ?? []).reduce((s, periodo) => s + (periodo.metrics.grossSales ?? 0), 0)
    expect(suma).toBe(r.summary.grossSales)
    // ⭐ (B5 r1 M-2): los cobros de las barras, como la cabecera, sin los de cuentas de tarjetas (el efectivo y el pagado con saldo).
    const cobros = (r.byPeriod ?? []).reduce((s, periodo) => s + periodo.metrics.transactionCount, 0)
    expect(cobros).toBe(r.summary.transactionCount)
    expect(cobros).toBe(2)
  })

  it('con filtro de método no se calculan las cifras de tarjetas (son de la vista completa)', async () => {
    const r = await getSalesSummary(venueId, { ...rango, paymentMethod: 'CASH', timezone: 'America/Mexico_City' })
    expect(r.summary.giftCardLoads).toBeUndefined()
    expect(r.summary.paidWithGiftCardBalance).toBeUndefined()
    expect(r.salesByPaymentMethod).toBeUndefined()
  })

  it('🔴 Inicio (basic-metrics) dice lo mismo que el reporte: la venta de tarjetas no es venta', async () => {
    const m = await getBasicMetricsData(venueId, { fromDate: rango.startDate, toDate: rango.endDate, responseMode: 'aggregated-v1' })
    expect(m.summary.totalAmount).toBe(500)
    expect(m.paymentMethodsData).toEqual(
      expect.arrayContaining([
        { method: 'Efectivo', total: 300, count: 1 },
        { method: 'Otro', total: 200, count: 1 },
      ]),
    )
    expect(m.paymentMethodsData.find(x => x.method === 'Tarjeta')).toBeUndefined()
  })

  it('🔴 MCP: el desglose por método trae GIFT_CARD (no OTHER) y deja fuera la venta de tarjetas; las cargas, aparte', async () => {
    const filtros = {
      fromDate: new Date(rango.startDate),
      toDate: new Date(rango.endDate),
      includeRefunds: true,
      excludeCancelledOrders: true,
    }
    const filas = await aggregatePaymentsByMethod(venueId, filtros)
    expect(filas.sort((a, b) => a.method.localeCompare(b.method))).toEqual([
      { method: 'CASH', amount: 300, tips: 0, count: 1 },
      { method: 'GIFT_CARD', amount: 200, tips: 0, count: 1 },
    ])
    // $500 + $300 − $300 (la cancelación resta: el REFUND viene negativo); r1 (M-1): cuenta las dos cargas, no el reembolso.
    expect(await aggregateGiftCardLoads(venueId, filtros)).toEqual({ amount: 500, count: 2 })
  })
})

describe('🔴 full-testing v2 · un negocio sin tarjetas en el rango no recibe «ventas por método» (el panel usa el dinero, que es igual)', () => {
  let venueId: string

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('ventas-sin-tarjetas')
    venueId = negocio.venueId
    await sembrarCobro({ venueId, staffId: negocio.staffId, saleCents: 30000 })
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('sin cargas ni saldo, el campo no va y el desglose de siempre sigue igual', async () => {
    const rango = { startDate: new Date(Date.now() - 60 * 60_000).toISOString(), endDate: new Date(Date.now() + 60 * 60_000).toISOString() }
    const r = await getSalesSummary(venueId, { ...rango, groupBy: 'paymentMethod', timezone: 'America/Mexico_City' })
    expect(r.salesByPaymentMethod).toBeUndefined()
    expect(r.byPaymentMethod?.map(m => [m.method, m.amount])).toEqual([['CASH', 300]])
  })
})

describe('🔴 full-testing v2 #3 · el detalle dice de qué venta es la tarjeta: cuántas tarjetas y por cuánto', () => {
  let venueId: string
  let venta: Awaited<ReturnType<typeof sembrarVentaDeTarjetas>>

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('detalle-venta')
    venueId = negocio.venueId
    const { staffId, organizationId } = negocio
    venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500, 300], metodo: 'CASH' })
    // Un ajuste mueve el saldo, no lo que costó la venta.
    await prisma.giftCard.update({ where: { id: venta.giftCardIds[0] }, data: { balance: D(450) } })
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('las 2 tarjetas de la venta y su suma ($800), desde cualquiera de las dos', async () => {
    for (const id of venta.giftCardIds) {
      const d = await getGiftCardDetail(venueId, id, {})
      expect(d.sale).toEqual({ cards: 2, amount: 800 })
    }
  })
})

describe('B5 · un abono devuelto de una venta de tarjetas SIN pagar no resta de «tarjetas cargadas»', () => {
  let venueId: string

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('🔴 «tarjetas cargadas» cuenta sólo las ventas PAGADAS y sus cancelaciones: nunca sale negativa', async () => {
    const negocio = await crearNegocioDePrueba('ventas-abono')
    venueId = negocio.venueId
    const rango = {
      startDate: new Date(Date.now() - 60 * 60_000).toISOString(),
      endDate: new Date(Date.now() + 60 * 60_000).toISOString(),
    }
    // El cliente abona $200 a una venta de $500 que nunca se termina de pagar, y se le devuelven.
    const { staffId, organizationId } = negocio
    const sinPagar = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [500], abonosConTerminal: [200] })
    await devolverConTerminal({ venueId, orderId: sinPagar.orderId, staffId, monto: 200, originalPaymentId: sinPagar.abonos[0].id })
    // r1 (M-1): y otro abono de $100 a otra venta de tarjetas que tampoco se termina de pagar (sus sobres siguen PENDING: $0).
    await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [300], abonosConTerminal: [100] })

    const r = await getSalesSummary(venueId, { ...rango, timezone: 'America/Mexico_City' })
    expect(r.summary.giftCardLoads).toBe(0)
    expect(r.summary.giftCardLoadsCount).toBe(0)
    // Y tampoco es devolución de mercancía.
    expect(r.summary.refunds).toBe(0)
    // El MCP dice lo mismo: ningún abono de una venta sin pagar es una tarjeta cargada.
    const filtros = {
      fromDate: new Date(rango.startDate),
      toDate: new Date(rango.endDate),
      includeRefunds: true,
      excludeCancelledOrders: true,
    }
    expect(await aggregateGiftCardLoads(venueId, filtros)).toEqual({ amount: 0, count: 0 })
  })
})

describe('B5 · turno (R3): la venta de tarjetas no es venta del turno; su efectivo sí está en el cajón', () => {
  let venueId: string
  let shiftId: string
  let abre: Date

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('ventas-turno')
    venueId = negocio.venueId
    const { staffId, organizationId } = negocio
    const turno = await abrirTurno(venueId, staffId)
    shiftId = turno.id
    abre = turno.startTime

    // $300 de mercancía en efectivo, $500 de una tarjeta vendida en efectivo y $200 de mercancía pagada con su saldo.
    await sembrarCobro({ venueId, staffId, saleCents: 30000, shiftId })
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CASH' })
    const canje = await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })
    await prisma.payment.updateMany({ where: { venueId, orderId: { in: [venta.orderId, canje.orderId] } }, data: { shiftId } })
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('🔴 turno abierto (lo que sondea la PAX): una consulta real que excluye la venta de tarjetas', async () => {
    const turno = await getCurrentShift(venueId)
    expect(turno?.id).toBe(shiftId)
    expect(Number(turno!.totalSales)).toBe(500) // $300 + $200 con saldo; la tarjeta vendida no
    expect(Number(turno!.totalCashPayments)).toBe(800) // el efectivo de la tarjeta vendida SÍ entró al cajón
    expect(Number(turno!.totalOtherPayments)).toBe(200)
  })

  it('🔴 resumen de turnos: totalSales sin la venta de tarjetas; el desglose por método la conserva y suma 100 %', async () => {
    const r = await getShiftsSummary(venueId, {
      startTime: new Date(Date.now() - 60 * 60_000).toISOString(),
      endTime: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    expect(r.summary.totalSales).toBe(500)
    expect(r.paymentMethods.sort((a, b) => a.method.localeCompare(b.method))).toEqual([
      { method: 'CASH', total: 800, percentage: 80 },
      { method: 'OTHER', total: 200, percentage: 20 },
    ])
    // r1 (Fix 2): las ventas por cajero y la tendencia dicen lo mismo que la cabecera.
    expect(r.staffSales.reduce((suma, s) => suma + s.totalSales, 0)).toBe(500)
    expect(r.salesTrend.reduce((suma, punto) => suma + punto.value, 0)).toBe(500)
  })

  it('🔴 cierre: el cursor real trae la marca de tarjetas y la aritmética del cierre la excluye de totalSales', async () => {
    const cobros = await readShiftPaymentsForClose(venueId, shiftId, abre, new Date(Date.now() + 60_000))
    const t = aggregateShiftPayments(cobros)
    expect(t.totalSales.toString()).toBe('500')
    expect(t.totalCashPayments.toString()).toBe('800')
    // r1 (M-5): el saldo no es efectivo del cajón (ni como «extra»): ningún faltante falso.
    expect(t.totalDrawerExtra.toString()).toBe('0')
    expect(t.totalCashTips.toString()).toBe('0')
  })

  it('🔴 r1 (M-5) · el cierre REAL firma ventas sin la tarjeta y espera en el cajón el fondo + $800', async () => {
    const { shift } = await closeShiftForVenueWithResult(venueId, shiftId, { cashReconciliationAction: 'SKIPPED' })
    expect(shift.status).toBe('CLOSED')
    expect(shift.totalSales.toString()).toBe('500')
    expect(shift.totalCashPayments.toString()).toBe('800')
    expect(shift.totalOtherPayments.toString()).toBe('200')
    const bitacora = await prisma.activityLog.findFirst({
      where: { venueId, action: 'SHIFT_CLOSED', entityId: shiftId },
      select: { data: true },
    })
    const firmado = bitacora?.data as { expectedCash?: string; expectedSource?: string } | null
    // Sin gaveta, el esperado es el del turno: fondo inicial + efectivo (la tarjeta vendida en efectivo SÍ entró).
    expect(firmado?.expectedSource).toBe('TURNO')
    expect(firmado?.expectedCash).toBe(shift.startingCash.add(800).toFixed(2))
  })
})

describe('B5 r1 · MCP contra Postgres real: dinero vs ventas (ejemplo del revisor)', () => {
  let venueId: string
  let merchantAccountId: string
  const herramientas = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  const llamar = async (nombre: string, args: Record<string, unknown>) =>
    JSON.parse((await herramientas.get(nombre)!(args, {})).content[0].text)

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('ventas-mcp')
    venueId = negocio.venueId
    const { staffId, organizationId } = negocio
    const proveedor = await prisma.paymentProvider.upsert({
      where: { code: 'ANGELPAY' },
      update: {},
      create: { code: 'ANGELPAY', name: 'AngelPay', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    })
    merchantAccountId = (
      await prisma.merchantAccount.create({
        data: {
          providerId: proveedor.id,
          externalMerchantId: `ventas-mcp-${venueId}`,
          alias: 'Comercio de prueba',
          credentialsEncrypted: {},
        },
      })
    ).id

    // $300 en efectivo + $500 de una tarjeta vendida con tarjeta bancaria (cae en el comercio) + $200 pagados con su saldo.
    await sembrarCobro({ venueId, staffId, saleCents: 30000 })
    const venta = await sembrarVentaDeTarjetas({ venueId, organizationId, staffId, montos: [500], metodo: 'CREDIT_CARD' })
    await prisma.payment.update({ where: { id: venta.pagos[0].id }, data: { merchantAccountId } })
    await sembrarCanje({ venueId, staffId, giftCardIds: venta.giftCardIds, total: 200, conSaldo: 200 })

    const acceso = { role: 'OWNER', corePermissions: ['analytics:read', 'payments:read'] }
    const scope = {
      staffId,
      activeOrg: organizationId,
      scopes: ['mcp:read'],
      allowedVenueIds: [venueId],
      perVenueAccess: new Map([[venueId, acceso]]),
    } as unknown as McpScope
    const servidor = { tool: (...a: unknown[]) => herramientas.set(a[0] as string, a[a.length - 1] as never) } as never
    registerSalesTools(servidor, scope)
    registerOverviewTools(servidor, scope)
    registerTrendTools(servidor, scope)
    registerPaymentTools(servidor, scope)
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('🔴 daily_sales corre en Postgres: ventas sin la carga, saldo como GIFT_CARD, cargas aparte y el comercio con su dinero', async () => {
    const out = await llamar('daily_sales', { venueId })
    expect(out.gross).toBe(500)
    expect(out.completedCount).toBe(2)
    expect(out.byMethod).toEqual({ CASH: 300, GIFT_CARD: 200 })
    expect(out.giftCardLoads).toBe(500)
    expect(out.byMerchantAccount).toEqual({ [merchantAccountId]: 500 })
  })

  it('🔴 sales_by_payment_method: grossCollected = dinero ($800 sin GIFT_CARD); netSales = ventas ($500 con GIFT_CARD)', async () => {
    const out = await llamar('sales_by_payment_method', { venueId })
    expect(out.grossCollected).toEqual({
      total: 800,
      byMethod: [
        { method: 'CREDIT_CARD', total: 500, count: 1 },
        { method: 'CASH', total: 300, count: 1 },
      ],
    })
    expect(out.netSales).toEqual({
      total: 500,
      byMethod: [
        { method: 'CASH', total: 300, count: 1 },
        { method: 'GIFT_CARD', total: 200, count: 1 },
      ],
    })
    expect(out.giftCardLoads).toEqual({ total: 500, count: 1 })
  })

  // Pendientes 1a · tarea 1: lo vendido son $300 en efectivo + $200 pagados con saldo = $500. Los $500 de la carga son dinero, no venta.
  it('🔴 pendientes 1a · today_overview: las ventas de hoy sin la carga de tarjetas y con el saldo', async () => {
    const out = await llamar('today_overview', { venueId })
    expect(out.salesToday.gross).toBe(500)
    expect(out.salesToday.payments).toBe(2)
  })

  it('🔴 pendientes 1a · sales_comparison y revenue_by_venue cuentan ventas, no cargas', async () => {
    const comparacion = await llamar('sales_comparison', { venueId })
    expect(comparacion.current.gross).toBe(500)
    expect(comparacion.current.transactions).toBe(2)

    const porNegocio = await llamar('revenue_by_venue', {})
    expect(porNegocio.venues.find((v: { venueId: string }) => v.venueId === venueId).gross).toBe(500)
    expect(porNegocio.total).toBe(500)
  })

  it('🔴 pendientes 1a · staff_ranking, channel_mix y peak_hours no cuentan la cuenta de tarjetas', async () => {
    // Las tres órdenes son del mismo cajero y del mismo canal: con la cuenta de tarjetas serían $1,000 y 3 órdenes.
    const ranking = await llamar('staff_ranking', { venueId })
    expect(ranking.staff).toMatchObject([{ revenue: 500, orders: 2 }])

    const canales = await llamar('channel_mix', { venueId })
    expect(canales.channels).toMatchObject([{ channel: 'TAKEOUT', revenue: 500, count: 2 }])

    // Las horas se reparten por la hora de cada orden (pueden caer en dos horas): lo que importa es la suma.
    const { hours } = await llamar('peak_hours', { venueId })
    expect(hours.reduce((s: number, h: { sales: number }) => s + h.sales, 0)).toBe(500)
    expect(hours.reduce((s: number, h: { transactions: number }) => s + h.transactions, 0)).toBe(2)
  })

  it('🔴 pendientes 1a · list_payments lista el cobro de la carga y su resumen dice giftCardLoads', async () => {
    const out = await llamar('list_payments', { venueId })
    // La lista es DINERO: el cobro de $500 de la carga se queda y el resumen sigue sumando los tres cobros.
    expect(out.count).toBe(3)
    expect(out.payments.map((p: { amount: number }) => p.amount).sort((a: number, b: number) => a - b)).toEqual([200, 300, 500])
    expect(out.summary.completed.gross).toBe(1000)
    // ...pero dice cuánto de ese bruto es la venta de tarjetas, para que el asistente no lo cuente como venta.
    expect(out.summary.giftCardLoads).toEqual({ count: 1, amount: 500 })
    expect(out.summary.note).toContain('$500.00')
    expect(out.summary.note).toContain('cobrados en cuentas de tarjetas de regalo (abonos incluidos')
  })
})

describe('🔴 Codex #5 (cierre) · R3 en los lectores de turnos del PANEL y del MCP: $1,000 de cargas + $200 de mercancía', () => {
  let venueId: string
  let shiftId: string
  const herramientas = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  const llamar = async (nombre: string, args: Record<string, unknown>) =>
    JSON.parse((await herramientas.get(nombre)!(args, {})).content[0].text)
  const rango = () => ({
    startTime: new Date(Date.now() - 60 * 60_000).toISOString(),
    endTime: new Date(Date.now() + 60 * 60_000).toISOString(),
  })

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('turno-panel')
    venueId = negocio.venueId
    const { staffId, organizationId } = negocio
    shiftId = (await abrirTurno(venueId, staffId)).id
    // Por el camino REAL de cobro (`payCashOrder`): así el acumulado del turno abierto (`paymentShiftClaim`) también lo cuenta.
    const carga = await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [1000], abonosEnEfectivo: [1000] })
    // Las dos órdenes son del turno (el detalle cuenta sus órdenes por `Order.shiftId`).
    await prisma.order.update({ where: { id: carga.orderId }, data: { shiftId } })
    const mercancia = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `TP-${Date.now()}`,
        shiftId,
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: D(200),
        taxAmount: D(0),
        total: D(200),
        remainingBalance: D(200),
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        items: { create: [{ productName: 'Blusa', quantity: 1, unitPrice: D(200), taxAmount: D(0), total: D(200) }] },
      },
    })
    await payCashOrder(venueId, mercancia.id, { amount: 20000, tip: 0, staffId, idempotencyKey: `tp-blusa-${venueId}`.slice(0, 64) })

    const scope = {
      staffId,
      activeOrg: organizationId,
      scopes: ['mcp:read'],
      allowedVenueIds: [venueId],
      perVenueAccess: new Map([[venueId, { role: 'OWNER', corePermissions: ['shifts:read'] }]]),
    } as unknown as McpScope
    registerShiftTools({ tool: (...a: unknown[]) => herramientas.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('turno ABIERTO: detalle, lista y resumen del panel y list_shifts dicen $200; el efectivo por método, $1,200', async () => {
    // Precondición: el acumulado del turno abierto SÍ trae la carga (sus escritores no se tocan; los lectores la quitan).
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).totalSales.toString()).toBe('1200')

    const detalle = await detalleDelTurnoDelPanel(venueId, shiftId)
    expect(detalle.totalSales).toBe(200)
    expect(detalle.paymentMethodBreakdown.find((m: { method: string }) => m.method === 'CASH')).toMatchObject({ total: 1200 })
    expect(detalle.staffBreakdown.reduce((suma: number, s: { sales: number }) => suma + s.sales, 0)).toBe(200)
    // Cierre r1: la cuenta de tarjetas tampoco es una orden de venta del turno (ticket promedio = $200 / 1, no / 2).
    expect([detalle.totalOrders, detalle.stats.totalOrders, detalle.stats.avgOrderValue]).toEqual([1, 1, 200])
    // Full-testing v2 #2: ni la lista de órdenes del detalle ni «Productos vendidos» la cuentan (sólo la blusa).
    expect([detalle.orders.length, detalle.stats.totalProducts]).toEqual([1, 1])

    const lista = await turnosDelPanel(venueId, 1, 10, rango())
    expect(lista.data.find((t: { id: string }) => t.id === shiftId)?.totalSales).toBe(200)
    expect((await resumenDeTurnosDelPanel(venueId, rango())).summary.totalSales).toBe(200)
    expect((await llamar('list_shifts', { venueId })).shifts.map((t: { sales: number }) => t.sales)).toEqual([200])
  })

  it('turno CERRADO: el detalle ya no reemplaza el total firmado por la suma de todos los cobros', async () => {
    await closeShiftForVenueWithResult(venueId, shiftId, { cashReconciliationAction: 'SKIPPED' })
    const detalle = await detalleDelTurnoDelPanel(venueId, shiftId)
    expect(detalle.totalSales).toBe(200)
    expect(detalle.paymentMethodBreakdown.find((m: { method: string }) => m.method === 'CASH')).toMatchObject({ total: 1200 })
    expect((await llamar('list_shifts', { venueId, status: 'closed' })).shifts).toEqual([
      expect.objectContaining({ sales: 200, cash: 1200 }),
    ])
  })
})

describe('🔴 pendientes 1a · turnos: la cuenta de tarjetas no suma órdenes', () => {
  let venueId: string
  let shiftId: string
  let ventaEnDosCobros: string
  // El contador del turno (`Shift.totalOrders` y `totalSales`) tras cada cobro, en orden. Se siembra todo en el `beforeAll` por
  // el camino REAL (`payCashOrder` → `paymentShiftClaim`), para que una prueba que falla no deje a las siguientes sin datos.
  type Paso = 'inicio' | 'tarjetas' | 'mercancia' | 'abono' | 'resto'
  const contador = {} as Record<Paso, { ordenes: number; ventas: number }>
  const delta = (de: Paso, a: Paso) => [contador[a].ordenes - contador[de].ordenes, contador[a].ventas - contador[de].ventas]

  beforeAll(async () => {
    const { venueId: v, organizationId, staffId } = await crearNegocioDePrueba('turno-ordenes')
    venueId = v
    shiftId = (await abrirTurno(venueId, staffId)).id
    const leer = async (paso: Paso) => {
      const t = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId }, select: { totalOrders: true, totalSales: true } })
      contador[paso] = { ordenes: t.totalOrders, ventas: Number(t.totalSales) }
    }
    const cobrarEnEfectivo = (orderId: string, pesos: number) =>
      payCashOrder(venueId, orderId, { amount: pesos * 100, tip: 0, staffId, idempotencyKey: `to-${orderId}-${pesos}`.slice(0, 64) })

    await leer('inicio')
    await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [300], abonosEnEfectivo: [300] })
    await leer('tarjetas')
    const mercancia = await crearCuentaDeMercancia({ venueId, staffId, total: 150 })
    await cobrarEnEfectivo(mercancia.orderId, 150)
    await leer('mercancia')
    // Review Focus 3: una venta de tarjetas pagada en dos cobros (abono + resto).
    ventaEnDosCobros = (await sembrarVentaDeTarjetasSinPagar({ venueId, organizationId, staffId, montos: [400], abonosEnEfectivo: [100] }))
      .orderId
    await leer('abono')
    await cobrarEnEfectivo(ventaEnDosCobros, 300)
    await leer('resto')
    // El turno abierto y el cierre cuentan por `Order.shiftId`: las tres ventas (dos de tarjetas, una de mercancía) son de este turno.
    await prisma.order.updateMany({ where: { venueId }, data: { shiftId } })
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('cobrar una venta de tarjetas en efectivo por la ruta real no sube Shift.totalOrders; la mercancía sí', () => {
    // El dinero sí entra al acumulado del turno (su arreglo de ventas vive en lectura, `ventasDelTurno.ts`); la orden no.
    expect(delta('inicio', 'tarjetas')).toEqual([0, 300])
    expect(delta('tarjetas', 'mercancia')).toEqual([1, 150])
  })

  it('una venta de tarjetas pagada en dos cobros no suma en ninguno', async () => {
    expect(delta('mercancia', 'abono')).toEqual([0, 100])
    expect(delta('abono', 'resto')).toEqual([0, 300])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ventaEnDosCobros } })).paymentStatus).toBe('PAID')
  })

  it('getCurrentShift no cuenta la cuenta de tarjetas en totalOrders ni sus renglones en totalProductsSold', async () => {
    expect(await prisma.order.count({ where: { venueId, shiftId, status: 'COMPLETED' } })).toBe(3)

    const turno = await getCurrentShift(venueId)
    expect(turno?.id).toBe(shiftId)
    expect([turno!.totalOrders, turno!.totalProductsSold]).toEqual([1, 1]) // sólo la playera
  })

  it('🔴 al CERRAR el turno, el totalOrders guardado no cuenta los renglones de la cuenta de tarjetas', async () => {
    const { shift } = await closeShiftForVenueWithResult(venueId, shiftId, { cashReconciliationAction: 'SKIPPED' })
    expect(shift.status).toBe('CLOSED')
    expect([shift.totalOrders, shift.totalProductsSold]).toEqual([1, 1])
    const reporte = shift.reportData as { sales?: { totalOrders?: number; productsSold?: number } } | null
    expect([reporte?.sales?.totalOrders, reporte?.sales?.productsSold]).toEqual([1, 1])
  })
})

describe('🔴 1b S1 · Q37/Q44: el reintento de una venta compara contra la huella con que se creó, no contra los datos de hoy', () => {
  let venueId: string
  let staffId: string
  const llave = (nombre: string) => `s1-${nombre}-${process.pid}-${Date.now()}`.slice(0, 64)
  const vender = (idempotencyKey: string, cuerpo: Omit<CreateGiftCardOrderInput, 'idempotencyKey'>) =>
    createGiftCardOrder(venueId, staffId, { idempotencyKey, ...cuerpo })
  const sobresDe = (ids: string[]) =>
    prisma.giftCard.findMany({
      where: { venueId, id: { in: ids } },
      select: { ventaHuella: true, recipientPhone: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    })
  /** Deja los sobres de una venta como los guardaba la 1a: sin huella, y con los datos que se le pasan. */
  const comoLaUnoA = (ids: string[], datos: Prisma.GiftCardUpdateManyMutationInput) =>
    prisma.giftCard.updateMany({ where: { venueId, id: { in: ids } }, data: { ventaHuella: null, ...datos } })

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('ventas-huella')
    venueId = negocio.venueId
    staffId = negocio.staffId
    mockConPlan.add(venueId)
    await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('cambiar el destino no rompe el reintento de la venta; otro cuerpo con la misma llave sigue siendo 409', async () => {
    const k = llave('destino')
    const cuerpo = {
      purchaserName: 'Ana',
      sobres: [
        { amount: 500, deliveryChannel: 'WHATSAPP' as const, recipientName: 'Luis', recipientPhone: '5512345678' },
        { amount: 300, deliveryChannel: 'WHATSAPP' as const, recipientPhone: '55 1234 5678' },
      ],
    }
    const primera = await vender(k, cuerpo)
    const ids = primera.sobres.map(s => s.id)
    const guardados = await sobresDe(ids)
    expect(guardados.map(s => s.recipientPhone)).toEqual(['+525512345678', '+525512345678'])
    expect(guardados[0].ventaHuella).toEqual(expect.any(String))
    expect(new Set(guardados.map(s => s.ventaHuella)).size).toBe(1)

    // Lo que hará S4 (cambiar el destino): la tarjeta ya no va a ese WhatsApp, va a un correo.
    await prisma.giftCard.update({
      where: { id: ids[0] },
      data: { recipientPhone: null, recipientEmail: 'luis@example.test', deliveryChannel: 'EMAIL' },
    })

    await expect(vender(k, cuerpo)).resolves.toMatchObject({ replay: true, orderId: primera.orderId })
    await expect(vender(k, { ...cuerpo, sobres: [cuerpo.sobres[0]] })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    })
  })

  it('Q44: una venta guardada con las reglas de la 1a (teléfono sin lada, sin huella) se repite', async () => {
    const k = llave('unoa')
    const cuerpo = { purchaserName: 'Ana', sobres: [{ amount: 500, deliveryChannel: 'WHATSAPP' as const, recipientPhone: '5512345678' }] }
    const primera = await vender(k, cuerpo)
    await comoLaUnoA(
      primera.sobres.map(s => s.id),
      { recipientPhone: '5512345678' },
    )
    await expect(vender(k, cuerpo)).resolves.toMatchObject({ replay: true, orderId: primera.orderId })
  })

  it('Q44: una venta de la 1a por WhatsApp SIN «De parte de» se repite (nunca el 400 de E3)', async () => {
    const k = llave('sinde')
    const sobres = [{ amount: 400, deliveryChannel: 'WHATSAPP' as const, recipientPhone: '5512345678' }]
    const primera = await vender(k, { purchaserName: 'Ana', sobres })
    await comoLaUnoA(
      primera.sobres.map(s => s.id),
      { recipientPhone: '5512345678', purchaserName: null },
    )
    await expect(vender(k, { sobres })).resolves.toMatchObject({ replay: true, orderId: primera.orderId })
  })

  it('Q44: una venta de la 1a con un teléfono que la regex aceptó y libphonenumber rechaza se repite (nunca GIFT_CARD_PHONE_INVALID)', async () => {
    const k = llave('ceros')
    const primera = await vender(k, {
      purchaserName: 'Ana',
      sobres: [{ amount: 600, deliveryChannel: 'WHATSAPP', recipientPhone: '5512345678' }],
    })
    await comoLaUnoA(
      primera.sobres.map(s => s.id),
      { recipientPhone: '0000000000' },
    )
    const reintento = {
      purchaserName: 'Ana',
      sobres: [{ amount: 600, deliveryChannel: 'WHATSAPP' as const, recipientPhone: '0000000000' }],
    }
    await expect(vender(k, reintento)).resolves.toMatchObject({ replay: true, orderId: primera.orderId })
    // Y una venta NUEVA con ese teléfono sí se rechaza.
    await expect(vender(llave('ceros-nueva'), reintento)).rejects.toMatchObject({ code: 'GIFT_CARD_PHONE_INVALID', statusCode: 400 })
  })

  it('Q44: una venta de la 1a con un teléfono «00…» que al convertirse queda con menos de 10 dígitos se repite (nunca 400)', async () => {
    // «00376312345» (Andorra con salida internacional): la 1a lo aceptó (11 dígitos); convertido es «+376312345», 9 dígitos.
    const k = llave('doble-cero')
    const primera = await vender(k, {
      purchaserName: 'Ana',
      sobres: [{ amount: 700, deliveryChannel: 'WHATSAPP', recipientPhone: '5512345678' }],
    })
    await comoLaUnoA(
      primera.sobres.map(s => s.id),
      { recipientPhone: '00376312345' },
    )
    const reintento = {
      purchaserName: 'Ana',
      sobres: [{ amount: 700, deliveryChannel: 'WHATSAPP' as const, recipientPhone: '00376312345' }],
    }
    await expect(vender(k, reintento)).resolves.toMatchObject({ replay: true, orderId: primera.orderId })
  })
})

/**
 * 1b S4 · Q110 y Q36: la venta es de la sesión (`iniciadoPor` sólo es nota) y repetirla ya no es otra salida del código: el
 * reintento lo trae sólo sin `CODE_REPLACED` y el mismo día del negocio, y cada sobre cuyo código sale lleva su renglón REPLAY,
 * esté como esté (M1 de la revisión de S4).
 */
describe('🔴 1b S4 · Q110/Q36: repetir la venta', () => {
  let venueId: string
  let staffId: string
  let gerenteId: string
  const ANA = 'cl9ana0000000000000000000'
  const llave = (nombre: string) => `s4-${nombre}-${process.pid}-${Date.now()}`.slice(0, 64)
  const cuerpo = (idempotencyKey: string) => ({
    idempotencyKey,
    purchaserName: 'Luis',
    sobres: [
      { amount: 500, deliveryChannel: 'WHATSAPP' as const, recipientName: 'Ana', recipientPhone: '5512345678' },
      { amount: 300, deliveryChannel: 'PRINTED' as const },
    ],
  })
  /** La ruta de la venta por su controller REAL (bitácora REPLAY incluida). */
  async function vender(body: Record<string, unknown>) {
    const req: any = { params: { venueId }, body, headers: {}, ip: '127.0.0.1', get: () => 'jest', authContext: { userId: staffId } }
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    await venderPorElController(req, res)
    return res.json.mock.calls[0][0].data
  }
  const reveladas = (ids: string[]) =>
    prisma.activityLog.findMany({ where: { venueId, action: 'GIFT_CARD_CODE_REVEALED', entityId: { in: ids } }, take: 20 })
  async function pagar(orderId: string) {
    await payCashOrder(venueId, orderId, { amount: 80000, tip: 0, staffId, idempotencyKey: llave(`pago-${orderId.slice(-6)}`) })
  }

  beforeAll(async () => {
    const negocio = await crearNegocioDePrueba('ventas-s4')
    venueId = negocio.venueId
    staffId = negocio.staffId
    mockConPlan.add(venueId)
    await prisma.giftCardSettings.create({ data: { venueId, enabled: true, suggestedAmounts: [500, 1000, 2000] } })
    gerenteId = (await prisma.staff.create({ data: { email: `${llave('g')}@gerente.test`, firstName: 'G', lastName: 'G', active: true } }))
      .id
    await prisma.staffVenue.create({ data: { staffId: gerenteId, venueId, role: 'MANAGER', active: true } })
  })

  afterAll(async () => {
    await limpiarNegocioDePrueba(venueId)
  })

  it('Q110: B crea la venta con iniciadoPor A ⇒ es de B; el reenvío con o sin esos campos es replay (no IDEMPOTENCY_KEY_REUSED)', async () => {
    const k = llave('q110')
    const primera = await createGiftCardOrder(venueId, staffId, { ...cuerpo(k), iniciadoPor: ANA, iniciadoPorNombre: 'Ana' })
    const orden = await prisma.order.findUniqueOrThrow({ where: { id: primera.orderId }, select: { createdById: true, servedById: true } })
    expect(orden).toEqual({ createdById: staffId, servedById: staffId })
    await expect(createGiftCardOrder(venueId, staffId, cuerpo(k))).resolves.toMatchObject({ replay: true, orderId: primera.orderId })
    await expect(
      createGiftCardOrder(venueId, staffId, { ...cuerpo(k), iniciadoPor: 'cl9otra000000000000000000', iniciadoPorNombre: 'Otra' }),
    ).resolves.toMatchObject({ replay: true })
  })

  it('repetir la venta tras reponer desde el panel ⇒ sin código (y ningún renglón REVEALED)', async () => {
    const k = llave('repuesta')
    const v = await vender(cuerpo(k))
    await pagar(v.orderId)
    await operarSobreDeGerente(venueId, v.sobres[0].id, gerenteId, {
      operationKey: llave('repone'),
      tipo: 'REEMPLAZAR_CODIGO',
      reason: 'LOST_CARD',
      folio: v.orderNumber,
    })
    const otra = await vender(cuerpo(k))
    expect(otra.replay).toBe(true)
    expect(otra.sobres[0]).toMatchObject({ codigo: null, pageToken: null, pageUrl: null, codigoOculto: true })
    expect(await reveladas([v.sobres[0].id])).toHaveLength(0)
  })

  it('repetir la venta otro día ⇒ sin código', async () => {
    const k = llave('otrodia')
    const v = await vender(cuerpo(k))
    await pagar(v.orderId)
    const ids = v.sobres.map((s: { id: string }) => s.id)
    await prisma.giftCard.updateMany({ where: { id: { in: ids } }, data: { activatedAt: new Date(Date.now() - 48 * 3600_000) } })
    const otra = await vender(cuerpo(k))
    expect(otra.sobres.map((s: any) => [s.codigo, s.codigoOculto])).toEqual([
      [null, true],
      [null, true],
    ])
    expect(await reveladas(ids)).toHaveLength(0)
  })

  it('repetir la venta el mismo día sin reponer ⇒ con código y un renglón REVEALED (REPLAY) por sobre en cada reenvío', async () => {
    const k = llave('mismo')
    const v = await vender(cuerpo(k))
    const ids = v.sobres.map((s: { id: string }) => s.id)
    const comoRenglon = (filas: Awaited<ReturnType<typeof reveladas>>) =>
      filas.map(f => [f.entityId, (f.data as any).motivo, (f.data as any).idempotencyKey]).sort()
    // La creación no escribe; el reenvío de la venta aún PENDING sí: el código vuelve a salir (M1).
    expect(await reveladas(ids)).toHaveLength(0)
    const pendiente = await vender(cuerpo(k))
    expect(pendiente.sobres.map((s: any) => s.codigo)).toEqual(v.sobres.map((s: any) => s.codigo))
    expect(comoRenglon(await reveladas(ids))).toEqual(ids.map((id: string) => [id, 'REPLAY', k]).sort())

    await pagar(v.orderId)
    const activa = await vender(cuerpo(k))
    expect(activa.sobres.map((s: any) => s.codigo)).toEqual(v.sobres.map((s: any) => s.codigo))
    const filas = await reveladas(ids)
    expect(comoRenglon(filas)).toEqual([...ids, ...ids].map((id: string) => [id, 'REPLAY', k]).sort())
    expect(JSON.stringify(filas.map(f => f.data))).not.toContain(v.sobres[0].codigo)
  })

  it('🔴 M1: repetir la venta del día con un sobre BLOCKED ⇒ su código sale, y con su renglón REPLAY', async () => {
    const k = llave('bloqueada')
    const v = await vender(cuerpo(k))
    await pagar(v.orderId)
    await operarSobreDeGerente(venueId, v.sobres[0].id, gerenteId, {
      operationKey: llave('bloquea'),
      tipo: 'BLOQUEAR',
      reason: 'SUSPICIOUS_ACTIVITY',
    })
    const otra = await vender(cuerpo(k))
    expect(otra.sobres[0]).toMatchObject({ status: 'BLOCKED', codigo: v.sobres[0].codigo })
    const filas = await reveladas([v.sobres[0].id])
    expect(filas.map(f => [(f.data as any).motivo, (f.data as any).idempotencyKey])).toEqual([['REPLAY', k]])
  })

  it('Q37 con S4: change-destination y luego repetir la venta original ⇒ 200 replay (y sin código: hubo CODE_REPLACED)', async () => {
    const k = llave('q37')
    const v = await vender(cuerpo(k))
    await pagar(v.orderId)
    await cambiarDestinoDeTarjeta(
      venueId,
      v.sobres[0].id,
      { staffId, puedeVender: true, puedeGestionar: true },
      {
        operationKey: llave('cambia'),
        destino: { deliveryChannel: 'EMAIL', recipientEmail: 'ana@example.test' },
      },
    )
    const otra = await vender(cuerpo(k))
    expect(otra).toMatchObject({ replay: true, orderId: v.orderId })
    expect(otra.sobres[0]).toMatchObject({ codigo: null, codigoOculto: true })
    expect(otra.sobres[1].codigo).toBe(v.sobres[1].codigo)
  })
})
