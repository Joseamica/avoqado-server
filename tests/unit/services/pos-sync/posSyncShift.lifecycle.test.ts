/**
 * 🔴 DINERO — pos-sync no puede reabrir ni re-firmar un turno que el TPV ya reclamó/cerró.
 *
 * El cutoff durable del claim es `updatedAt` mientras el estado es CLOSING. Por eso toda
 * escritura de pos-sync parte del snapshot observado y gana sólo mediante CAS. Un evento tardío
 * sobre CLOSED es idempotente; `closed` sobre OPEN firma la misma membresía Payment que el cierre
 * TPV, nunca los importes de Order.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { processPosShiftEvent } from '@/services/pos-sync/posSyncShift.service'
import { posSyncStaffService } from '@/services/pos-sync/posSyncStaff.service'

jest.mock('@/services/pos-sync/posSyncStaff.service', () => ({
  posSyncStaffService: { syncPosStaff: jest.fn() },
}))

const VENUE = 'venue-pos-lifecycle'
const TURNO = 'turno-pos-lifecycle'
const EXTERNAL = 'WS-LIFECYCLE'
const START = new Date('2026-09-03T14:00:00.000Z')
const OBSERVED_AT = new Date('2026-09-03T20:00:00.000Z')
const CLAIMED_AT = new Date('2026-09-03T21:00:00.000Z')
const CUTOFF = new Date('2026-09-03T22:00:00.000Z')

const payload = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  shiftData: {
    externalId: EXTERNAL,
    staffId: 'staff-pos',
    posRawData: {
      apertura: START.toISOString(),
      cierre: CUTOFF.toISOString(),
      fondo: 500,
      efectivo: 690,
    },
    ...over,
  },
})

function shift(over: Record<string, unknown> = {}) {
  return {
    id: TURNO,
    venueId: VENUE,
    staffId: 'staff-pos',
    externalId: EXTERNAL,
    startTime: START,
    endTime: null,
    status: 'OPEN',
    startingCash: new Decimal('500.00'),
    endingCash: null,
    cashDifference: null,
    cashDeclared: null,
    cardDeclared: null,
    vouchersDeclared: null,
    otherDeclared: null,
    totalSales: new Decimal('999.00'),
    totalTips: new Decimal('99.00'),
    totalCashPayments: new Decimal('111.00'),
    totalCardPayments: new Decimal('222.00'),
    totalVoucherPayments: new Decimal('333.00'),
    totalOtherPayments: new Decimal('444.00'),
    totalCashTips: new Decimal('55.00'),
    totalOrders: 17,
    totalProductsSold: 0,
    inventoryConsumed: null,
    reportData: null,
    notes: null,
    originSystem: 'POS_SOFTRESTAURANT',
    posRawData: null,
    closedById: null,
    createdAt: START,
    updatedAt: OBSERVED_AT,
    ...over,
  }
}

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'payment-base',
  amount: new Decimal('100.00'),
  tipAmount: new Decimal('10.00'),
  method: 'CASH',
  fundsFlow: null,
  tenderTypeId: null,
  tenderCountsAsCash: null,
  ...over,
})

function expectObservedCas(call: any, observed: ReturnType<typeof shift>) {
  expect(call.where).toEqual({
    id: TURNO,
    venueId: VENUE,
    status: 'OPEN',
    endTime: observed.endTime,
    updatedAt: OBSERVED_AT,
  })
}

function expectCloseClaim(call: any, claimedAt = CLAIMED_AT) {
  expect(call).toEqual({
    where: {
      id: TURNO,
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      updatedAt: OBSERVED_AT,
    },
    data: { status: 'CLOSING', updatedAt: claimedAt },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-pos' })
  ;(posSyncStaffService.syncPosStaff as jest.Mock).mockResolvedValue('staff-pos')
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.order.count.mockResolvedValue(0)
  prismaMock.order.aggregate.mockResolvedValue({ _sum: {}, _count: {} })
  // Hace visible el comportamiento viejo durante RED; GREEN no debe tocar este camino.
  prismaMock.shift.upsert.mockResolvedValue(shift())
})

describe('processPosShiftEvent — el claim y la firma son inmutables', () => {
  it.each(['created', 'updated'] as const)('%s no puede convertir CLOSING en OPEN', async event => {
    const claimed = shift({ status: 'CLOSING', updatedAt: CUTOFF })
    prismaMock.shift.findUnique.mockResolvedValue(claimed)

    await expect(processPosShiftEvent(payload(), event)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHIFT_CLOSE_IN_PROGRESS',
    })

    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.shift.upsert).not.toHaveBeenCalled()
    expect(prismaMock.shift.create).not.toHaveBeenCalled()
  })

  it('closed no puede sobrescribir un CLOSING ni mover su cutoff', async () => {
    const claimed = shift({ status: 'CLOSING', updatedAt: CUTOFF })
    prismaMock.shift.findUnique.mockResolvedValue(claimed)

    await expect(processPosShiftEvent(payload(), 'closed')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHIFT_CLOSE_IN_PROGRESS',
    })

    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
    expect(prismaMock.order.aggregate).not.toHaveBeenCalled()
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(claimed.updatedAt).toBe(CUTOFF)
  })

  it.each(['created', 'updated', 'closed'] as const)('%s tardío sobre CLOSED devuelve la firma intacta', async event => {
    const signed = shift({ status: 'CLOSED', endTime: CUTOFF, updatedAt: CUTOFF })
    prismaMock.shift.findUnique.mockResolvedValue(signed)

    const result = await processPosShiftEvent(
      payload({ posRawData: { apertura: START.toISOString(), cierre: '2026-09-04T05:00:00Z' } }),
      event,
    )

    expect(result).toBe(signed)
    expect(result).toMatchObject({
      status: 'CLOSED',
      endTime: CUTOFF,
      totalSales: new Decimal('999.00'),
      totalTips: new Decimal('99.00'),
      totalOrders: 17,
    })
    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.shift.upsert).not.toHaveBeenCalled()
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
    expect(prismaMock.order.aggregate).not.toHaveBeenCalled()
  })
})

describe('processPosShiftEvent closed — Payment canónico + CAS observado', () => {
  it('reclama OPEN antes de leer y finaliza con el mismo claimedAt del servidor', async () => {
    jest.useFakeTimers().setSystemTime(CLAIMED_AT)
    const observed = shift()
    const closed = shift({ status: 'CLOSED', endTime: CLAIMED_AT, updatedAt: CLAIMED_AT })
    prismaMock.shift.findUnique.mockResolvedValueOnce(observed).mockResolvedValueOnce(observed).mockResolvedValueOnce(closed)
    prismaMock.payment.findMany.mockResolvedValue([
      payment({ id: 'exacto', amount: new Decimal('100.10'), tipAmount: new Decimal('10.05') }),
      payment({
        id: 'huerfano-cutoff',
        amount: new Decimal('80.20'),
        tipAmount: new Decimal('0.05'),
        method: 'OTHER',
        fundsFlow: 'RECEIVABLE',
        tenderTypeId: 'vale-cash',
        tenderCountsAsCash: true,
      }),
      payment({ id: 'refund', amount: new Decimal('-20.00'), tipAmount: new Decimal('0.00'), method: 'OTHER' }),
    ])
    prismaMock.order.count.mockResolvedValue(3)
    prismaMock.shift.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })

    try {
      expect(await processPosShiftEvent(payload(), 'closed')).toBe(closed)
    } finally {
      jest.useRealTimers()
    }

    expectCloseClaim(prismaMock.shift.updateMany.mock.calls[0][0])
    expect(prismaMock.shift.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.payment.findMany.mock.invocationCallOrder[0])
    expect(prismaMock.shift.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.order.count.mock.invocationCallOrder[0])

    const paymentRead = prismaMock.payment.findMany.mock.calls[0][0]
    expect(paymentRead).toEqual({
      where: {
        venueId: VENUE,
        status: 'COMPLETED',
        OR: [
          { shiftId: TURNO },
          {
            shiftId: null,
            createdAt: { gte: START, lte: CLAIMED_AT },
            order: { venueId: VENUE, shiftId: TURNO },
          },
        ],
      },
      select: {
        id: true,
        amount: true,
        tipAmount: true,
        method: true,
        fundsFlow: true,
        tenderTypeId: true,
        tenderCountsAsCash: true,
      },
      orderBy: { id: 'asc' },
      take: 500,
    })
    expect(prismaMock.order.aggregate).not.toHaveBeenCalled()
    expect(prismaMock.order.count).toHaveBeenCalledWith({ where: { shiftId: TURNO } })

    const finalize = prismaMock.shift.updateMany.mock.calls[1][0]
    expect(finalize.where).toEqual({ id: TURNO, venueId: VENUE, status: 'CLOSING', endTime: null, updatedAt: CLAIMED_AT })
    expect(finalize.data.status).toBe('CLOSED')
    expect(finalize.data.endTime).toEqual(CLAIMED_AT)
    expect((finalize.data.totalSales as Decimal).toFixed(2)).toBe('160.30')
    expect((finalize.data.totalTips as Decimal).toFixed(2)).toBe('10.10')
    expect((finalize.data.totalCashPayments as Decimal).toFixed(2)).toBe('100.10')
    expect((finalize.data.totalCashTips as Decimal).toFixed(2)).toBe('10.05')
    expect((finalize.data.totalOtherPayments as Decimal).toFixed(2)).toBe('60.20')
    expect(finalize.data.totalOrders).toBe(3)
    expect(finalize.data).not.toHaveProperty('totalDrawerExtra')
  })

  it.each([
    ['futuro', '2099-01-01T00:00:00.000Z'],
    ['nulo', null],
    ['anterior a apertura', '1970-01-01T00:00:00.000Z'],
  ])('el cierre externo %s queda sólo en provenance: claimedAt manda para query y firma', async (_case, externalClose) => {
    jest.useFakeTimers().setSystemTime(CLAIMED_AT)
    const observed = shift()
    const closed = shift({ status: 'CLOSED', endTime: CLAIMED_AT, updatedAt: CLAIMED_AT })
    prismaMock.shift.findUnique.mockResolvedValueOnce(observed).mockResolvedValueOnce(observed).mockResolvedValueOnce(closed)
    prismaMock.shift.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })

    try {
      await processPosShiftEvent(payload({ posRawData: { apertura: START.toISOString(), cierre: externalClose } }), 'closed')
    } finally {
      jest.useRealTimers()
    }

    expectCloseClaim(prismaMock.shift.updateMany.mock.calls[0][0])
    expect(prismaMock.payment.findMany.mock.calls[0][0].where.OR[1].createdAt.lte).toEqual(CLAIMED_AT)
    expect(prismaMock.shift.updateMany.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        where: { id: TURNO, venueId: VENUE, status: 'CLOSING', endTime: null, updatedAt: CLAIMED_AT },
        data: expect.objectContaining({ status: 'CLOSED', endTime: CLAIMED_AT }),
      }),
    )
  })

  it('libera sólo su propio claim si la lectura financiera falla', async () => {
    jest.useFakeTimers().setSystemTime(CLAIMED_AT)
    const observed = shift()
    prismaMock.shift.findUnique.mockResolvedValue(observed)
    prismaMock.shift.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 })
    prismaMock.payment.findMany.mockRejectedValue(new Error('payment read unavailable'))

    try {
      await expect(processPosShiftEvent(payload(), 'closed')).rejects.toThrow('payment read unavailable')
    } finally {
      jest.useRealTimers()
    }

    expectCloseClaim(prismaMock.shift.updateMany.mock.calls[0][0])
    expect(prismaMock.shift.updateMany.mock.calls[1][0]).toEqual({
      where: { id: TURNO, venueId: VENUE, status: 'CLOSING', endTime: null, updatedAt: CLAIMED_AT },
      data: { status: 'OPEN' },
    })
  })

  it('si el claim gana entre lectura y CAS, no mueve cutoff ni firma y responde retryable', async () => {
    const observed = shift()
    const claimed = shift({ status: 'CLOSING', updatedAt: CUTOFF })
    prismaMock.shift.findUnique.mockResolvedValueOnce(observed).mockResolvedValueOnce(observed).mockResolvedValueOnce(claimed)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 0 })

    await expect(processPosShiftEvent(payload(), 'closed')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHIFT_CLOSE_IN_PROGRESS',
    })

    expectObservedCas(prismaMock.shift.updateMany.mock.calls[0][0], observed)
    expect(claimed.updatedAt).toBe(CUTOFF)
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
    expect(prismaMock.shift.upsert).not.toHaveBeenCalled()
  })

  it('si otro evento OPEN gana el CAS, exige reintento en vez de sobrescribirlo', async () => {
    const observed = shift()
    prismaMock.shift.findUnique
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce(shift({ updatedAt: CUTOFF }))
    prismaMock.shift.updateMany.mockResolvedValue({ count: 0 })

    await expect(processPosShiftEvent(payload(), 'closed')).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHIFT_CONCURRENT_UPDATE',
    })
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
    expect(prismaMock.shift.upsert).not.toHaveBeenCalled()
  })

  it('si otro cierre gana el CAS, el retry devuelve su firma canónica sin reescribirla', async () => {
    const observed = shift()
    const winner = shift({ status: 'CLOSED', endTime: CUTOFF, updatedAt: CUTOFF })
    prismaMock.shift.findUnique.mockResolvedValueOnce(observed).mockResolvedValueOnce(observed).mockResolvedValueOnce(winner)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 0 })

    expect(await processPosShiftEvent(payload(), 'closed')).toBe(winner)
    expect(prismaMock.shift.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
    expect(prismaMock.shift.upsert).not.toHaveBeenCalled()
  })
})

describe('processPosShiftEvent created/updated — conserva el contrato OPEN con CAS', () => {
  it('updated gana sólo contra el snapshot OPEN observado y relee la fila canónica', async () => {
    const observed = shift()
    const saved = shift({ updatedAt: CUTOFF, startingCash: new Decimal('700.00') })
    prismaMock.shift.findUnique.mockResolvedValueOnce(observed).mockResolvedValueOnce(observed).mockResolvedValueOnce(saved)
    prismaMock.shift.updateMany.mockResolvedValue({ count: 1 })

    expect(await processPosShiftEvent(payload({ posRawData: { apertura: START.toISOString(), fondo: 700 } }), 'updated')).toBe(saved)

    const cas = prismaMock.shift.updateMany.mock.calls[0][0]
    expectObservedCas(cas, observed)
    expect(cas.data).toMatchObject({ status: 'OPEN', startTime: START, endTime: null })
    expect(new Decimal(cas.data.startingCash).toFixed(2)).toBe('700.00')
    expect(prismaMock.payment.findMany).not.toHaveBeenCalled()
    expect(prismaMock.shift.upsert).not.toHaveBeenCalled()
  })
})
