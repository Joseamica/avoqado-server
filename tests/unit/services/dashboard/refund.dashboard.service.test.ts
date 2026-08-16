import { PaymentType, TransactionStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'

// logAction is globally mocked to a no-op jest.fn in tests/__helpers__/setup.ts,
// so we assert the audit dual-write on the mock itself (not prismaMock.activityLog).

jest.mock('@/services/dashboard/rawMaterial.service', () => ({
  adjustStock: jest.fn(),
}))

describe('refund.dashboard.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.shift.findFirst.mockResolvedValue(null)
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
    prismaMock.payment.update.mockResolvedValue({ id: 'payment-original' })
    // El prismaMock compartido no declara los modelos del cajón. Se agregan aquí
    // (mismo patrón que `refund.mobile.service.test.ts`) para no tocar un helper
    // que otras sesiones editan.
    ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(null) }
    ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
  })

  it('rejects refund quantity that exceeds previously refunded quantity for the same order item', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'payment-original',
          venueId: 'venue-1',
          status: TransactionStatus.COMPLETED,
          type: PaymentType.REGULAR,
          method: 'CASH',
          source: 'APP',
          amount: 10,
          tipAmount: 0,
          orderId: 'order-1',
          shiftId: null,
          merchantAccountId: null,
          processorData: {},
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'refund-1',
          amount: -6.67,
          createdAt: new Date('2026-04-17T10:00:00.000Z'),
          status: TransactionStatus.COMPLETED,
          processorData: {
            refundedItems: [
              {
                orderItemId: 'oi-1',
                quantity: 2,
                amountCents: 667,
                amount: 6.67,
              },
            ],
          },
        },
      ])

    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'oi-1',
        productId: 'prod-1',
        productName: 'Shake',
        quantity: 3,
        total: new Decimal(10),
      },
    ])

    await expect(
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        items: [{ orderItemId: 'oi-1', quantity: 2 }],
        reason: 'RETURNED_GOODS',
      }),
    ).rejects.toThrow(/exceeds remaining refundable quantity/i)

    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('uses deterministic cents allocation for remaining partial item refund and updates cumulative refunded cents', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'payment-original',
          venueId: 'venue-1',
          status: TransactionStatus.COMPLETED,
          type: PaymentType.REGULAR,
          method: 'CASH',
          source: 'APP',
          amount: 10,
          tipAmount: 0,
          orderId: 'order-1',
          shiftId: null,
          merchantAccountId: null,
          processorData: {
            refunds: [
              {
                refundPaymentId: 'refund-1',
                amount: 3.34,
                amountCents: 334,
                reason: 'RETURNED_GOODS',
              },
            ],
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'refund-1',
          amount: -3.34,
          createdAt: new Date('2026-04-17T10:00:00.000Z'),
          status: TransactionStatus.COMPLETED,
          processorData: {
            refundedItems: [
              {
                orderItemId: 'oi-1',
                quantity: 1,
                amountCents: 334,
                amount: 3.34,
              },
            ],
          },
        },
      ])

    prismaMock.orderItem.findMany.mockResolvedValue([
      {
        id: 'oi-1',
        productId: 'prod-1',
        productName: 'Shake',
        quantity: 3,
        total: new Decimal(10),
      },
    ])
    prismaMock.payment.create.mockResolvedValue({ id: 'refund-2' })

    const result = await issueRefund({
      venueId: 'venue-1',
      paymentId: 'payment-original',
      items: [{ orderItemId: 'oi-1', quantity: 2 }],
      reason: 'RETURNED_GOODS',
    })

    expect(result.amount).toBe(6.66)
    expect(result.remainingRefundable).toBe(0)
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: new Decimal(-6.66),
          processorData: expect.objectContaining({
            amountCents: 666,
            refundedItems: [
              expect.objectContaining({
                orderItemId: 'oi-1',
                quantity: 2,
                amountCents: 666,
                amount: 6.66,
              }),
            ],
          }),
        }),
      }),
    )
    expect(prismaMock.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processorData: expect.objectContaining({
            refundedAmount: 10,
            refundedAmountCents: 1000,
          }),
        }),
      }),
    )
  })

  it('writes a REFUND_CREATED ActivityLog row for a successful refund (audit trail)', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'payment-original',
          venueId: 'venue-1',
          status: TransactionStatus.COMPLETED,
          type: PaymentType.REGULAR,
          method: 'CASH',
          source: 'APP',
          amount: 10,
          tipAmount: 0,
          orderId: 'order-1',
          shiftId: null,
          merchantAccountId: null,
          processorData: {},
        },
      ])
      .mockResolvedValueOnce([]) // no existing refunds
    prismaMock.payment.create.mockResolvedValue({ id: 'refund-amount-1' })

    const result = await issueRefund({
      venueId: 'venue-1',
      paymentId: 'payment-original',
      amount: 500, // cents → 5.00
      reason: 'ACCIDENTAL_CHARGE',
      staffId: 'staff-9',
      note: 'customer double-charged',
    })

    expect(result.amount).toBe(5)
    // Money op → must dual-write to ActivityLog. The owner audit screen reads only
    // ActivityLog, so a refund without this row is invisible to it.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'REFUND_CREATED',
        entity: 'Payment',
        entityId: 'refund-amount-1',
        staffId: 'staff-9',
        venueId: 'venue-1',
        data: expect.objectContaining({
          amount: 5, // pesos (major units), NOT cents
          reason: 'ACCIDENTAL_CHARGE',
          originalPaymentId: 'payment-original',
          source: 'DASHBOARD',
        }),
      }),
    )
  })

  /**
   * 🔴 EL DEFECTO DE DINERO MEDIDO EN HARDWARE EL 2026-08-16.
   *
   * Este servicio es el que usa la app de verdad (`POST /mobile/venues/:venueId/
   * payments/:paymentId/refund`), y NO tocaba el cajón: el arqueo marcaba $50,380
   * con $50,230 físicos — un sobrante inventado exactamente del tamaño de lo
   * reembolsado. El gemelo de `/mobile/.../refunds` sí restaba, pero ningún
   * cliente lo llama.
   */
  describe('cajón de efectivo — el reembolso en efectivo RESTA', () => {
    const pagoOriginal = (over: Record<string, unknown> = {}) => ({
      id: 'payment-original',
      venueId: 'venue-1',
      status: TransactionStatus.COMPLETED,
      type: PaymentType.REGULAR,
      method: 'CASH',
      source: 'APP',
      amount: 10,
      tipAmount: 0,
      orderId: 'order-1',
      shiftId: null,
      merchantAccountId: null,
      processorData: {},
      fundsFlow: null,
      tenderTypeId: null,
      tenderCountsAsCash: null,
      ...over,
    })

    const reembolsar = (over: Record<string, unknown> = {}) =>
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        amount: 15000, // cents → $150.00
        reason: 'RETURNED_GOODS',
        staffId: 'staff-9',
        ...over,
      })

    beforeEach(() => {
      prismaMock.payment.create.mockResolvedValue({ id: 'refund-cash-1' })
    })

    it('🔴 con caja ABIERTA crea un PAY_OUT por lo devuelto (era el sobrante inventado)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ amount: 200 })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      const result = await reembolsar()

      expect(result.amount).toBe(150)
      const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
      expect(args.data[0]).toMatchObject({ sessionId: 'session-1', venueId: 'venue-1', type: 'PAY_OUT' })
      expect(Number(args.data[0].amount)).toBe(150)
    })

    it('🔴 la propina devuelta también sale del cajón (el efectivo físico la incluía)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ amount: 100, tipAmount: 20 })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      // $120 = $100 de venta + $20 de propina: el split interno no debe cambiar
      // lo que sale de la caja, que es el efectivo total entregado.
      await reembolsar({ amount: 12000 })

      expect(Number((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0].amount)).toBe(120)
    })

    it('🔴 un reembolso de un cobro con TARJETA no toca el cajón', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ method: 'CREDIT_CARD', amount: 200 })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await reembolsar()

      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })

    it('🔴 la decisión sale de tenderSemantics sobre el pago REAL, no de un método del cuerpo del cliente', async () => {
      // Vale de despensa: method=OTHER pero cuenta como efectivo físico.
      prismaMock.$queryRaw
        .mockResolvedValueOnce([pagoOriginal({ method: 'OTHER', tenderTypeId: 'tender-vale', tenderCountsAsCash: true, amount: 200 })])
        .mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await reembolsar()

      expect(Number((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0].amount)).toBe(150)
    })

    it('🔴 SIN caja abierta el reembolso se emite igual (fail-open: la caja no autoriza devoluciones)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ amount: 200 })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue(null)

      await expect(reembolsar()).resolves.toMatchObject({ refundId: 'refund-cash-1', amount: 150, status: 'COMPLETED' })
      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })

    it('🔴 si la escritura del cajón REVIENTA, el reembolso sigue devolviendo COMPLETED', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ amount: 200 })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })
      ;(prismaMock as any).cashDrawerEvent.createMany.mockRejectedValue(new Error('DB caída'))

      await expect(reembolsar()).resolves.toMatchObject({ status: 'COMPLETED' })
    })

    it('🔴 idempotente: la llave se deriva del id del reembolso, un reintento no resta dos veces', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ amount: 200 })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await reembolsar()

      const args = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0]
      expect(args.data[0].localId).toBe('srv-refund:refund-cash-1')
      expect(args.skipDuplicates).toBe(true)
    })

    it('la nota del movimiento arranca con "Reembolso:" (el corte del POS clasifica por ese prefijo)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ amount: 200 })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await reembolsar()

      expect((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0].note).toMatch(/^Reembolso: /)
    })

    // ── REGRESIÓN: el enganche del cajón no puede romper las 8 cosas del servicio ──

    it('🔴 sigue creando el Payment negativo, el VenueTransaction y el ActivityLog', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ amount: 200 })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await reembolsar()

      expect(prismaMock.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: PaymentType.REFUND, status: TransactionStatus.COMPLETED, amount: new Decimal(-150) }),
        }),
      )
      expect(prismaMock.venueTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'REFUND' }) }),
      )
      expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'REFUND_CREATED' }))
    })

    it('🔴 sigue respetando el límite de lo que queda por devolver (candado contra doble reembolso)', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([pagoOriginal({ amount: 100 })])
        .mockResolvedValueOnce([{ id: 'refund-prev', amount: -100, createdAt: new Date(), status: 'COMPLETED', processorData: {} }])

      await expect(reembolsar({ amount: 10000 })).rejects.toThrow(/exceeds remaining refundable/i)
      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })

    it('🔴 un reembolso RECHAZADO no mueve el cajón (no hay dinero que devolver)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoOriginal({ status: 'PENDING' })]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await expect(reembolsar()).rejects.toThrow(/Cannot refund payment with status/i)
      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })
  })
})
