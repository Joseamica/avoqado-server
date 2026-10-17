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

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
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
import type { McpScope } from '@/mcp/scope'
import { abrirTurno, sembrarCobro } from '../dashboard/sembrarCobroParaReembolso'
import {
  crearNegocioDePrueba,
  limpiarEfectosDePagoDelNegocio,
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
    await limpiarEfectosDePagoDelNegocio(venueId)
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

describe('B5 · un abono devuelto de una venta de tarjetas SIN pagar no resta de «tarjetas cargadas»', () => {
  let venueId: string

  afterAll(async () => {
    await limpiarEfectosDePagoDelNegocio(venueId)
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
    await limpiarEfectosDePagoDelNegocio(venueId)
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

    const acceso = { role: 'OWNER', corePermissions: ['analytics:read'] }
    const scope = {
      staffId,
      activeOrg: organizationId,
      scopes: ['mcp:read'],
      allowedVenueIds: [venueId],
      perVenueAccess: new Map([[venueId, acceso]]),
    } as unknown as McpScope
    registerSalesTools({ tool: (...a: unknown[]) => herramientas.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  })

  afterAll(async () => {
    await limpiarEfectosDePagoDelNegocio(venueId)
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
})
