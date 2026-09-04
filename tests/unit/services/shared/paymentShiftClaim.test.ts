import { Prisma } from '@prisma/client'

import {
  claimShiftForCompletedPayment,
  claimShiftForCapturedPayment,
  claimShiftForRefund,
  recordPendingPaymentShiftReconciliation,
  resolvePaymentShiftReconciliationEnabled,
} from '@/services/shared/paymentShiftClaim'

const VENUE_ID = 'venue-1'
const PAYMENT_ID = 'payment-1'

function makeTx(
  candidate: { id: string; status: string } | null,
  claimedCount = 1,
  settings: { enableShifts: boolean } | null = { enableShifts: true },
) {
  return {
    shift: {
      findFirst: jest.fn().mockResolvedValue(candidate),
      updateMany: jest.fn().mockResolvedValue({ count: claimedCount }),
    },
    activityLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
    venueSettings: {
      findUnique: jest.fn().mockResolvedValue(settings),
    },
  }
}

describe('paymentShiftClaim — claim transaccional del turno para dinero capturado', () => {
  it('el wrapper probado no toca Shift cuando el Payment no está COMPLETED', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    await expect(
      claimShiftForCompletedPayment(tx as never, {
        paymentStatus: 'PENDING',
        venueId: VENUE_ID,
        amountPesos: new Prisma.Decimal('10.00'),
        tipPesos: new Prisma.Decimal('0.00'),
        incrementTotalOrders: true,
      }),
    ).resolves.toBeNull()

    expect(tx.shift.findFirst).not.toHaveBeenCalled()
    expect(tx.shift.updateMany).not.toHaveBeenCalled()
  })

  it('el wrapper probado delega el claim canónico cuando el Payment está COMPLETED', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    await expect(
      claimShiftForCompletedPayment(tx as never, {
        paymentStatus: 'COMPLETED',
        venueId: VENUE_ID,
        amountPesos: new Prisma.Decimal('10.00'),
        tipPesos: new Prisma.Decimal('1.00'),
        incrementTotalOrders: true,
      }),
    ).resolves.toMatchObject({ shiftId: 'shift-open', pendingReason: null })

    expect(tx.shift.updateMany).toHaveBeenCalledTimes(1)
  })

  it('si falla el lookup previo del switch, conserva el default enabled y permite auditar el dinero', async () => {
    const lookup = {
      venueSettings: {
        findUnique: jest.fn().mockRejectedValue(new Error('settings timeout')),
      },
    }

    await expect(resolvePaymentShiftReconciliationEnabled(lookup as never, VENUE_ID)).resolves.toBe(true)
    expect(lookup.venueSettings.findUnique).toHaveBeenCalledTimes(1)
  })

  it('reclama con tenant/status/endTime y el claim mismo incrementa los totales en pesos', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    const claim = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos: new Prisma.Decimal('123.45'),
      tipPesos: new Prisma.Decimal('6.78'),
      incrementTotalOrders: true,
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

    const claim = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos,
      tipPesos,
      incrementTotalOrders: true,
    })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: 'order-1',
      staffId: 'staff-1',
      channel: 'recordOrderPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled: true,
    })

    expect(claim.shiftId).toBeNull()
    expect(claim.pendingReason).toBe('CLAIM_LOST')
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'PAYMENT_WITHOUT_SHIFT',
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
          totalPesos: '112.34',
        },
      },
    })
  })

  it('un turno ya CLOSING se conserva como candidato, no se muta y queda explícito', async () => {
    const tx = makeTx({ id: 'shift-closing', status: 'CLOSING' })
    const amountPesos = new Prisma.Decimal('25.00')
    const tipPesos = new Prisma.Decimal('0.00')

    const claim = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos,
      tipPesos,
      incrementTotalOrders: true,
    })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: null,
      staffId: null,
      channel: 'recordFastPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled: true,
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

    const missing = await claimShiftForCapturedPayment(tx as never, {
      venueId: VENUE_ID,
      amountPesos,
      tipPesos,
      incrementTotalOrders: true,
    })
    await recordPendingPaymentShiftReconciliation(tx as never, {
      claim: missing,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: 'order-1',
      staffId: 'staff-1',
      channel: 'payCashOrder',
      amountPesos,
      tipPesos,
      reconciliationEnabled: true,
    })

    expect(missing.pendingReason).toBe('NO_SHIFT')
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      reason: 'NO_SHIFT',
      channel: 'payCashOrder',
      totalPesos: '50.00',
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
      reconciliationEnabled: true,
    })
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(tx.venueSettings.findUnique).not.toHaveBeenCalled()
  })

  it('respeta enableShifts ?? true: false silencia y una fila ausente conserva la alerta', async () => {
    const amountPesos = new Prisma.Decimal('80.00')
    const tipPesos = new Prisma.Decimal('8.00')
    const claim = { shiftId: null, candidateShiftId: null, observedStatus: null, pendingReason: 'NO_SHIFT' as const }
    const disabledTx = makeTx(null, 1, { enableShifts: false })

    const disabled = await resolvePaymentShiftReconciliationEnabled(disabledTx as never, VENUE_ID)
    await recordPendingPaymentShiftReconciliation(disabledTx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: null,
      staffId: 'staff-1',
      channel: 'recordFastPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled: disabled,
    })

    expect(disabledTx.activityLog.create).not.toHaveBeenCalled()

    const defaultOnTx = makeTx(null, 1, null)
    const defaultOn = await resolvePaymentShiftReconciliationEnabled(defaultOnTx as never, VENUE_ID)
    await recordPendingPaymentShiftReconciliation(defaultOnTx as never, {
      claim,
      venueId: VENUE_ID,
      paymentId: PAYMENT_ID,
      orderId: null,
      staffId: 'staff-1',
      channel: 'recordFastPayment',
      amountPesos,
      tipPesos,
      reconciliationEnabled: defaultOn,
    })

    expect(defaultOnTx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(defaultOnTx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({
      amountPesos: '80.00',
      tipPesos: '8.00',
      totalPesos: '88.00',
      reason: 'NO_SHIFT',
    })
  })
})

describe('paymentShiftClaim — claim transaccional del turno para reembolsos', () => {
  it('historial de componentes incompleto: observa OPEN pero fuerza pendiente sin decrementarlo', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    const claim = await claimShiftForRefund(
      tx as never,
      {
        venueId: VENUE_ID,
        salesRefundPesos: new Prisma.Decimal('20.00'),
        tipRefundPesos: new Prisma.Decimal('10.00'),
        forcePendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
      } as never,
    )

    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'shift-open',
      observedStatus: 'OPEN',
      pendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
    })

    await recordPendingPaymentShiftReconciliation(
      tx as never,
      {
        claim,
        venueId: VENUE_ID,
        paymentId: PAYMENT_ID,
        orderId: 'order-1',
        staffId: 'staff-1',
        channel: 'issueRefund',
        amountPesos: new Prisma.Decimal('-20.00'),
        tipPesos: new Prisma.Decimal('-10.00'),
        unclassifiedPriorRefundPesos: new Prisma.Decimal('40.00'),
        reconciliationEnabled: true,
      } as never,
    )

    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: {
        action: 'PAYMENT_WITHOUT_SHIFT',
        entity: 'Payment',
        entityId: PAYMENT_ID,
        staffId: 'staff-1',
        venueId: VENUE_ID,
        data: {
          status: 'PENDING',
          reason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
          candidateShiftId: 'shift-open',
          observedShiftStatus: 'OPEN',
          paymentId: PAYMENT_ID,
          orderId: 'order-1',
          channel: 'issueRefund',
          amountPesos: '-20.00',
          tipPesos: '-10.00',
          totalPesos: '-30.00',
          shiftAttributionStatus: 'PENDING',
          unclassifiedPriorRefundPesos: '40.00',
        },
      },
    })
  })

  it('historial de componentes incompleto: sin candidato conserva la razón de historia y tampoco muta', async () => {
    const tx = makeTx(null)

    const claim = await claimShiftForRefund(
      tx as never,
      {
        venueId: VENUE_ID,
        salesRefundPesos: new Prisma.Decimal('30.00'),
        tipRefundPesos: new Prisma.Decimal('0.00'),
        forcePendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
      } as never,
    )

    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: null,
      observedStatus: null,
      pendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
    })
  })

  it('reclama el turno OPEN con un solo decremento tenant-safe de venta y propina', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    const claim = await claimShiftForRefund(tx as never, {
      venueId: VENUE_ID,
      salesRefundPesos: new Prisma.Decimal('45.67'),
      tipRefundPesos: new Prisma.Decimal('4.33'),
    })

    expect(tx.shift.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, endTime: null },
      orderBy: { startTime: 'desc' },
      select: { id: true, status: true },
    })
    expect(tx.shift.updateMany).toHaveBeenCalledWith({
      where: { id: 'shift-open', venueId: VENUE_ID, status: 'OPEN', endTime: null },
      data: {
        totalSales: { decrement: new Prisma.Decimal('45.67') },
        totalTips: { decrement: new Prisma.Decimal('4.33') },
      },
    })
    expect(claim).toEqual({
      shiftId: 'shift-open',
      candidateShiftId: 'shift-open',
      observedStatus: 'OPEN',
      pendingReason: null,
    })
  })

  it('trata CLOSING como dinero post-corte: conserva candidato y nunca lo decrementa', async () => {
    const tx = makeTx({ id: 'shift-closing', status: 'CLOSING' })

    const claim = await claimShiftForRefund(tx as never, {
      venueId: VENUE_ID,
      salesRefundPesos: new Prisma.Decimal('50.00'),
      tipRefundPesos: new Prisma.Decimal('10.00'),
    })

    expect(tx.shift.updateMany).not.toHaveBeenCalled()
    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'shift-closing',
      observedStatus: 'CLOSING',
      pendingReason: 'SHIFT_NOT_OPEN',
    })
  })

  it('si el cierre gana el CAS, conserva el OPEN observado como claim perdido sin atribuir turno', async () => {
    const tx = makeTx({ id: 'shift-lost', status: 'OPEN' }, 0)

    const claim = await claimShiftForRefund(tx as never, {
      venueId: VENUE_ID,
      salesRefundPesos: new Prisma.Decimal('50.00'),
      tipRefundPesos: new Prisma.Decimal('0.00'),
    })

    expect(claim).toEqual({
      shiftId: null,
      candidateShiftId: 'shift-lost',
      observedStatus: 'OPEN',
      pendingReason: 'CLAIM_LOST',
    })
  })

  it('omite totalTips cuando la devolución no incluye propina', async () => {
    const tx = makeTx({ id: 'shift-open', status: 'OPEN' })

    await claimShiftForRefund(tx as never, {
      venueId: VENUE_ID,
      salesRefundPesos: new Prisma.Decimal('50.00'),
      tipRefundPesos: new Prisma.Decimal('0.00'),
    })

    expect(tx.shift.updateMany.mock.calls[0][0].data).toEqual({
      totalSales: { decrement: new Prisma.Decimal('50.00') },
    })
  })
})
