/**
 * R3 (índice 1a): el `totalSales` del turno excluye las cuentas de tarjetas; el efectivo esperado NO cambia (una tarjeta pagada en
 * efectivo sí entró al cajón). r1 B-3: también en el turno abierto (`getCurrentShift`) y en el resumen (`getShiftsSummary`).
 * r2 #2: en el turno abierto, `totalSales` sale de UNA consulta agregada que ya excluye la venta de tarjetas (nunca la resta de dos
 * lecturas tomadas en momentos distintos). La prueba contra Postgres real está en `tests/integration/giftCards/ventas.integration.test.ts`.
 */
import { Prisma } from '@prisma/client'
import { WHERE_ORDEN_DE_TARJETAS } from '@/services/giftCards/giftCardMarks'
import { aggregateShiftPayments, getCurrentShift, getShiftsSummary } from '@/services/tpv/shift.tpv.service'
import { prismaMock } from '@tests/__helpers__/setup'

const cobro = (o: Record<string, unknown>) => ({
  amount: 0,
  tipAmount: 0,
  method: 'CASH',
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderCountsAsCash: null,
  order: { items: [] as Array<{ id: string }> },
  ...o,
})

describe('aggregateShiftPayments · tarjetas de regalo (R3)', () => {
  it('🔴 la venta de tarjetas no suma a totalSales, pero su efectivo sí cuenta en el cajón', () => {
    const t = aggregateShiftPayments([cobro({ amount: 300 }), cobro({ amount: 500, order: { items: [{ id: 'oi-gc' }] } })])
    expect(t.totalSales.toString()).toBe('300')
    expect(t.totalCashPayments.toString()).toBe('800')
  })

  it('la cancelación (REFUND) de una venta de tarjetas tampoco resta de totalSales', () => {
    const t = aggregateShiftPayments([
      cobro({ amount: 500, order: { items: [{ id: 'oi-gc' }] } }),
      cobro({ amount: -500, type: 'REFUND', order: { items: [{ id: 'oi-gc' }] } }),
      cobro({ amount: 100 }),
    ])
    expect(t.totalSales.toString()).toBe('100')
    expect(t.totalCashPayments.toString()).toBe('100')
  })

  it('lo pagado con saldo (OTHER del tender de sistema) sigue siendo venta del turno', () => {
    const t = aggregateShiftPayments([cobro({ amount: 200, method: 'OTHER', fundsFlow: 'EXTERNAL_RECORDED', tenderTypeId: 'tender-gc' })])
    expect(t.totalSales.toString()).toBe('200')
    expect(t.totalOtherPayments.toString()).toBe('200')
  })

  it('regresión: un llamador sin `order` (script de reatribución) suma como siempre', () => {
    const viejo = cobro({ amount: 120 })
    delete (viejo as { order?: unknown }).order
    expect('order' in viejo).toBe(false)
    expect(aggregateShiftPayments([viejo]).totalSales.toString()).toBe('120')
  })
})

describe('getCurrentShift · tarjetas de regalo (R3, r1 B-3, r2 #2)', () => {
  it('🔴 el turno abierto tampoco cuenta la venta de tarjetas en totalSales; el cajón y los métodos, igual', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({
      id: 'shift-1',
      venueId: 'v1',
      endTime: null,
      startTime: new Date('2026-10-14T15:00:00Z'),
    })
    prismaMock.payment.groupBy.mockResolvedValue([
      { method: 'CASH', _sum: { amount: new Prisma.Decimal(800), tipAmount: new Prisma.Decimal(0) } },
    ])
    // $800 en efectivo, de los que $500 fueron una venta de tarjetas: la base devuelve las ventas ya sin ella.
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(300) } })
    prismaMock.order.count.mockResolvedValue(2)
    prismaMock.orderItem.aggregate.mockResolvedValue({ _sum: { quantity: 2 } })
    const turno = await getCurrentShift('v1')
    expect(turno!.totalSales.toString()).toBe('300')
    expect(turno!.totalCashPayments.toString()).toBe('800')
    // En la base, con la MISMA marca que el resto de la plataforma (una consulta agregada, nunca filas al hilo de Node).
    expect(prismaMock.payment.aggregate).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.aggregate).toHaveBeenCalledWith({
      where: { venueId: 'v1', shiftId: 'shift-1', status: 'COMPLETED', NOT: { order: WHERE_ORDEN_DE_TARJETAS } },
      _sum: { amount: true },
    })
  })
})

describe('getShiftsSummary · tarjetas de regalo (R3, r1 B-3)', () => {
  it('🔴 el resumen tampoco cuenta la venta de tarjetas en totalSales; el desglose por método la conserva', async () => {
    const pago = (id: string, amount: number, deTarjetas: boolean) => ({
      id,
      amount: new Prisma.Decimal(amount),
      tipAmount: new Prisma.Decimal(0),
      processedById: null,
      processedBy: null,
      createdAt: new Date('2026-10-14T16:00:00Z'),
      method: 'CASH',
      order: { items: deTarjetas ? [{ id: 'oi-gc' }] : [] },
    })
    prismaMock.shift.findMany.mockResolvedValue([{ id: 'shift-1', orders: [], payments: [pago('p1', 300, false), pago('p2', 500, true)] }])
    prismaMock.payment.findMany.mockResolvedValue([pago('p3', 100, true)]) // huérfano (sin turno) de una venta de tarjetas
    prismaMock.order.count.mockResolvedValue(0)
    prismaMock.review.count.mockResolvedValue(0)
    const r = await getShiftsSummary('v1', { startTime: '2026-10-14T06:00:00.000Z', endTime: '2026-10-15T05:59:59.999Z' })
    expect(r.summary.totalSales).toBe(300)
    expect(r.paymentMethods).toEqual([{ method: 'CASH', total: 900, percentage: 100 }])
    const marca = { select: { items: { where: { giftCardId: { not: null } }, select: { id: true }, take: 1 } } }
    expect(prismaMock.shift.findMany.mock.calls[0][0].include.payments.select.order).toEqual(marca)
    expect(prismaMock.payment.findMany.mock.calls[0][0].select.order).toEqual(marca)
  })
})
