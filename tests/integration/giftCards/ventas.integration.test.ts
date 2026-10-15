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

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getBasicMetricsData } from '@/services/dashboard/generalStats.dashboard.service'
import { aggregateShiftPayments, getCurrentShift, getShiftsSummary, readShiftPaymentsForClose } from '@/services/tpv/shift.tpv.service'
import { aggregateGiftCardLoads, aggregatePaymentsByMethod } from '@/services/legacy/mergedPayments.service'
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
    // $500 + $300 − $300 (la cancelación resta: el REFUND viene negativo), tres cobros.
    expect(await aggregateGiftCardLoads(venueId, filtros)).toEqual({ amount: 500, count: 3 })
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

    const r = await getSalesSummary(venueId, { ...rango, timezone: 'America/Mexico_City' })
    expect(r.summary.giftCardLoads).toBe(0)
    expect(r.summary.giftCardLoadsCount).toBe(0)
    // Y tampoco es devolución de mercancía.
    expect(r.summary.refunds).toBe(0)
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
  })

  it('🔴 cierre: el cursor real trae la marca de tarjetas y la aritmética del cierre la excluye de totalSales', async () => {
    const cobros = await readShiftPaymentsForClose(venueId, shiftId, abre, new Date(Date.now() + 60_000))
    const t = aggregateShiftPayments(cobros)
    expect(t.totalSales.toString()).toBe('500')
    expect(t.totalCashPayments.toString()).toBe('800')
  })
})
