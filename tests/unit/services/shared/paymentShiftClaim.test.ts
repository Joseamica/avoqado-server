import { Prisma } from '@prisma/client'

import { claimShiftForCapturedPayment, recordPendingPaymentShiftReconciliation } from '@/services/shared/paymentShiftClaim'

const VENUE_ID = 'venue-1'
const PAYMENT_ID = 'payment-1'

function makeTx(candidate: { id: string; status: string } | null, claimedCount = 1) {
  return {
    shift: {
      findFirst: jest.fn().mockResolvedValue(candidate),
      updateMany: jest.fn().mockResolvedValue({ count: claimedCount }),
    },
    activityLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  }
}

describe('paymentShiftClaim — claim transaccional del turno para dinero capturado', () => {
  it('reclama con tenant/status/endTime y el claim mismo incrementa los totales en pesos', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    const claim = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos: new Prisma.Decimal('123.45'),
      tipPesos: new Prisma.Decimal('6.78'),
    })

    expect(tx.shift.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true, status: true },
    })
    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { id: 'shift-open', venueId: VENUE_ID, status: 'OPEN', endTime: null },
      data: {
        totalSales: { increment: new Prisma.Decimal('123.45') },
        totalTips: { increment: new Prisma.Decimal('6.78') },
        totalOrders: { increment: 1 },
      },
    })
    expect(claim).toEqual({
      shiftId: 'shift-open',
      candidateShiftId: 'shift-open',
      observedStatus: 'OPEN',
      pendingReason: null,
    })
  })

  it('si el cierre gana entre la lectura y el CAS no sella el turno y deja una anomalía atómica exacta', async () => {
    const tx = makeTx({ id: 'shift-closed-by-race', status: 'OPEN' }, 0)
    const amountPesos = new Prisma.Decimal('100.00')
    const tipPesos = new Prisma.Decimal('12.34')

    const claim = await claimShiftForCapturedPayment(tx as never, { venueId: VENUE_ID, amountPesos, tipPesos })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: 'order-1',
      staffId: 'staff-1',
      channel: 'recordOrderPayment',
      amountPesos,
      tipPesos,
    })

    expect(claim.shiftId).toBeNull()
    expect(claim.pendingReason).toBe('CLAIM_LOST')
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'PAYMENT_PENDING_POST_CLOSE_RECONCILIATION',
        entity: 'Payment',
        entityId: PAYMENT_ID,
        staffId: 'staff-1',
        venueId: VENUE_ID,
        data: {
          status: 'PENDING',
          reason: 'CLAIM_LOST',
          candidateShiftId: 'shift-closed-by-race',
          observedShiftStatus: 'OPEN',
          paymentId: PAYMENT_ID,
          orderId: 'order-1',
          channel: 'recordOrderPayment',
          amountPesos: '100.00',
          tipPesos: '12.34',
        },
      },
    })
  })

  it('un turno ya CLOSING se conserva como candidato, no se muta y queda explícito', async () => {
    const tx = makeTx({ id: 'shift-closing', status: 'CLOSING' })
    const amountPesos = new Prisma.Decimal('25.00')
    const tipPesos = new Prisma.Decimal('0.00')

    const claim = await claimShiftForCapturedPayment(tx as never, { venueId: VENUE_ID, amountPesos, tipPesos })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: null,
      staffId: null,
      channel: 'recordFastPayment',
      amountPesos,
      tipPesos,
    })

    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'shift-closing',
      observedStatus: 'CLOSING',
      pendingReason: 'SHIFT_NOT_OPEN',
    })
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })

  it('un venue sin turno captura igual y deja una sola conciliación explícita; un claim ganador no audita', async () => {
    const tx = makeTx(null)
    const amountPesos = new Prisma.Decimal('50.00')
    const tipPesos = new Prisma.Decimal('0.00')

    const missing = await claimShiftForCapturedPayment(tx as never, { venueId: VENUE_ID, amountPesos, tipPesos })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim: missing,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: 'order-1',
      staffId: 'staff-1',
      channel: 'payCashOrder',
      amountPesos,
      tipPesos,
    })

    expect(missing.pendingReason).toBe('NO_SHIFT')
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      candidateShiftId: null,
      observedShiftStatus: null,
      reason: 'NO_SHIFT',
      channel: 'payCashOrder',
    })

    tx.activityLog.create.mockClear()
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim: { shiftId: 'shift-winner', candidateShiftId: 'shift-winner', observedStatus: 'OPEN', pendingReason: null },
      venueId: VENUE_ID,
      paymentId: 'payment-2',
      orderId: 'order-2',
      staffId: 'staff-1',
      channel: 'payCashOrder',
      amountPesos,
      tipPesos,
    })
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })
})
