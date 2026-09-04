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

const ORDER_GENERATION = new Date('2026-09-04T09:00:00.000Z')

describe('refund.dashboard.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.payment.findFirst.mockResolvedValue({
      orderId: 'order-1',
      order: { updatedAt: ORDER_GENERATION },
    } as any)
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      // El lock de Order comparte `$queryRaw` con las dos lecturas Payment del servicio.
      // Interceptarlo aquí mantiene las colas `.mockResolvedValueOnce` enfocadas en Payment.
      const queryRaw = jest.fn(async (...args: any[]) => {
        const query = args[0]
        const sql = Array.isArray(query)
          ? query.join('?')
          : Array.isArray(query?.strings)
            ? query.strings.join('?')
            : Array.isArray(query?.sql)
              ? query.sql.join('?')
              : String(query)
        if (sql.includes('FROM "Order"')) return [{ id: 'order-1' }]
        return (prismaMock.$queryRaw as any)(...args)
      })
      return callback({ ...(prismaMock as any), $queryRaw: queryRaw })
    })
    prismaMock.shift.findFirst.mockResolvedValue(null)
    ;(prismaMock.activityLog.findFirst as jest.Mock).mockResolvedValue(null)
    prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-post-close-1' })
    prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' })
    prismaMock.payment.update.mockResolvedValue({ id: 'payment-original' })
    // El prismaMock compartido no declara los modelos del cajón. Se agregan aquí
    // (mismo patrón que `refund.mobile.service.test.ts`) para no tocar un helper
    // que otras sesiones editan.
    ;(prismaMock as any).cashDrawerSession = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    }
    ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
  })

  it.each([0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rechaza amount=%p si no es un entero positivo seguro antes de abrir transacción',
    async amount => {
      await expect(issueRefund({ venueId: 'venue-1', paymentId: 'payment-original', amount, reason: 'RETURNED_GOODS' })).rejects.toThrow(
        /amount.*entero seguro.*centavos/i,
      )

      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    },
  )

  it.each([-0.5, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rechaza tipRefundCents=%p si no es un entero no negativo seguro antes de abrir transacción',
    async tipRefundCents => {
      await expect(
        issueRefund({ venueId: 'venue-1', paymentId: 'payment-original', amount: 1000, tipRefundCents, reason: 'RETURNED_GOODS' }),
      ).rejects.toThrow(/tipRefundCents.*entero seguro.*centavos/i)

      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    },
  )

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
          // 🔴 `tipAmount` NO es decorativo en esta fila: desde la Task 5r «lo ya devuelto»
          // se mide como venta + propina (`shared/devueltoDeUnCobro.ts`) y la ausencia de la
          // llave REVIENTA a propósito — una fila de reembolso sin ella significa que el
          // `SELECT` dejó de pedir la columna, no que la propina fuera cero.
          tipAmount: 0,
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
          tipAmount: 0,
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

  it('reestablece paymentId + venueId + orderId bajo lock y conserva el mismo alcance al actualizar', async () => {
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
          fundsFlow: 'CASH_DRAWER',
          tenderTypeId: null,
          tenderCountsAsCash: null,
          tenderRevision: null,
          tenderLabel: null,
          tenderCaptureTip: null,
          tenderSatFormaPago: null,
        },
      ])
      .mockResolvedValueOnce([])
    prismaMock.payment.create.mockResolvedValue({ id: 'refund-tenant-scoped' } as any)

    await issueRefund({
      venueId: 'venue-1',
      paymentId: 'payment-original',
      amount: 500,
      reason: 'ACCIDENTAL_CHARGE',
      staffId: 'staff-1',
    })

    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith({
      where: { id: 'payment-original', venueId: 'venue-1' },
      select: { orderId: true, order: { select: { updatedAt: true } } },
    })
    const lockedPaymentQuery = (prismaMock.$queryRaw as jest.Mock).mock.calls[0][0]
    expect(String(lockedPaymentQuery.sql).replace(/\s+/g, ' ')).toMatch(/WHERE id = .*"venueId" = .*"orderId" =/)
    expect(lockedPaymentQuery.values).toEqual(['payment-original', 'venue-1', 'order-1'])
    expect(prismaMock.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'payment-original',
          venueId: 'venue-1',
          orderId: 'order-1',
          status: TransactionStatus.COMPLETED,
        }),
      }),
    )
  })

  it('sólo emite REFUND_AUTHORITY_CHANGED cuando el marker atómico confirma la reasignación posterior', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    ;(prismaMock.activityLog.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
      // Marker creado pre-commit antes de iniciar la refund: el filtro por reloj
      // lo perdería aunque el commit sea lo que desbloqueó el miss del lock.
      if (where.createdAt) return null
      return where.data?.equals === ORDER_GENERATION.toISOString() ? { id: 'marker-order-1' } : null
    })

    await expect(
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        amount: 500,
        reason: 'ACCIDENTAL_CHARGE',
        staffId: 'staff-autenticado',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'REFUND_AUTHORITY_CHANGED' })

    expect(prismaMock.activityLog.findFirst).toHaveBeenCalledWith({
      where: {
        action: 'ORDER_VENUE_REASSIGNED',
        entity: 'Order',
        entityId: 'order-1',
        venueId: 'venue-1',
        data: { path: ['sourceOrderUpdatedAt'], equals: ORDER_GENERATION.toISOString() },
      },
      select: { id: true },
    })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'REFUND_AUTHORITY_CHANGED', venueId: 'venue-1' }) }),
    )
  })

  it('Payment desaparecido o relinked sin marker devuelve conflicto genérico y no fabrica audit de reasignación', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])

    await expect(
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        amount: 500,
        reason: 'ACCIDENTAL_CHARGE',
        staffId: 'staff-autenticado',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'REFUND_AUTHORITY_UNAVAILABLE' })

    expect(prismaMock.activityLog.findFirst).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })

  it('un marker de una generación anterior no cambia un conflicto genérico a reasignación', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    ;(prismaMock.activityLog.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.data?.path?.[0] === 'fromVenueId') return { id: 'marker-viejo' }
      return where.data?.equals === '2026-09-03T08:00:00.000Z' ? { id: 'marker-viejo' } : null
    })

    await expect(
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        amount: 500,
        reason: 'ACCIDENTAL_CHARGE',
        staffId: 'staff-autenticado',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'REFUND_AUTHORITY_UNAVAILABLE' })

    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
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
        .mockResolvedValueOnce([
          { id: 'refund-prev', amount: -100, tipAmount: 0, createdAt: new Date(), status: 'COMPLETED', processorData: {} },
        ])

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

  /**
   * 🔴 DINERO — el reembolso HEREDA la identidad del tipo de pago original.
   *
   * El reembolso ya heredaba `method`, pero NADA de la semántica del tipo del catálogo.
   * Dos consecuencias medibles:
   *
   *  1. **Un vale que SÍ entra al cajón** (`countsAsPhysicalCash: true`, method OTHER):
   *     el cobro sumaba efectivo al cajón, y su reembolso —sin el snapshot— caía al
   *     fallback legacy `method === 'CASH'` = false. El arqueo seguiría exigiendo un
   *     efectivo que YA salió: un faltante inventado, en la dirección que acusa al cajero.
   *  2. El desglose del corte agrupa por `tenderLabel`: la venta aparecía bajo "Uber Eats"
   *     y su devolución en el genérico, así que el neto POR TIPO mentía.
   */
  describe('reembolso de un cobro con tipo de pago del catálogo', () => {
    const pagoUber = (over: Record<string, unknown> = {}) => ({
      id: 'payment-original',
      venueId: 'venue-1',
      status: TransactionStatus.COMPLETED,
      type: PaymentType.REGULAR,
      method: 'OTHER',
      source: 'APP',
      amount: 100,
      tipAmount: 0,
      orderId: 'order-1',
      shiftId: null,
      merchantAccountId: null,
      processorData: {},
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: 'tender-uber',
      tenderRevision: 3,
      tenderLabel: 'Uber Eats',
      tenderCountsAsCash: false,
      tenderCaptureTip: false,
      tenderSatFormaPago: '99',
      ...over,
    })

    const reembolsar = (over: Record<string, unknown> = {}) =>
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        amount: 5000, // $50.00
        reason: 'RETURNED_GOODS',
        staffId: 'staff-9',
        ...over,
      })

    beforeEach(() => {
      // 🔴 `jest.clearAllMocks()` NO vacía la cola de `mockResolvedValueOnce`: un test
      // anterior que lanza antes de consumir su segundo Once se lo hereda al siguiente,
      // que entonces recibe `[]` y falla con "Payment not found" sin culpa propia.
      prismaMock.$queryRaw.mockReset()
      prismaMock.payment.create.mockResolvedValue({ id: 'refund-tender-1' })
    })

    it('estampa el tipo original en el reembolso (si no, el desglose del corte miente)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoUber()]).mockResolvedValueOnce([])

      await reembolsar()

      expect(prismaMock.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenderTypeId: 'tender-uber',
            tenderRevision: 3,
            tenderLabel: 'Uber Eats',
            fundsFlow: 'EXTERNAL_RECORDED',
          }),
        }),
      )
    })

    it('🔴 un vale que SÍ entraba al cajón devuelve como efectivo del cajón', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([
          pagoUber({
            tenderTypeId: 'tender-vale',
            tenderLabel: 'Vale de despensa',
            tenderCountsAsCash: true,
            fundsFlow: 'CASH_DRAWER',
          }),
        ])
        .mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await reembolsar()

      expect(prismaMock.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenderCountsAsCash: true, fundsFlow: 'CASH_DRAWER' }),
        }),
      )
      // Y el cajón SÍ se mueve: ese dinero estaba físicamente adentro.
      expect((prismaMock as any).cashDrawerEvent.createMany).toHaveBeenCalled()
    })

    // La comisión NO se hereda a propósito: que Uber devuelva su 30% cuando el cliente
    // cancela es un acuerdo comercial que no conocemos. Inventarlo daría un ingreso o un
    // costo falso. Se deja vacío hasta que el founder lo decida.
    it('NO inventa una comisión negativa en el reembolso', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoUber()]).mockResolvedValueOnce([])

      await reembolsar()

      const data = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(data.tenderCommissionAmount).toBeUndefined()
      expect(data.tenderCommissionPercent).toBeUndefined()
    })

    // REGRESIÓN: un cobro clásico (sin tipo del catálogo) no gana campos de tender.
    it('un reembolso de efectivo normal sigue sin campos de tender', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([pagoUber({ method: 'CASH', fundsFlow: null, tenderTypeId: null, tenderLabel: null, tenderRevision: null })])
        .mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })

      await reembolsar()

      const data = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(data.tenderTypeId).toBeUndefined()
      expect(data.tenderLabel).toBeUndefined()
    })
  })
  /**
   * 🔴 DINERO — ¿de QUÉ turno sale el reembolso?
   *
   * Fase 1 del «turno de caja del negocio» (2-sep-2026): `issueRefund` dejó de condicionar
   * la búsqueda del turno a que viniera un `staffId` y ahora resuelve el turno abierto del
   * NEGOCIO (`@/services/shared/turnoDeCaja.ts`). Eso cambia a qué turno se le CARGA el
   * reembolso, no sólo quién lo firma — y hasta esta prueba TODOS los casos del archivo
   * mockeaban `shift.findFirst → null`, o sea que sólo se ejercitaba la rama sin turno.
   *
   * 🔴 **Task 5 (3-sep-2026) cambió la segunda mitad de esta regla, y a propósito.** Antes, sin
   * turno abierto, el reembolso caía al turno del COBRO ORIGINAL —normalmente uno ya CERRADO— y le
   * decrementaba sus totales. Eso reescribe hacia atrás un corte que una persona ya firmó: el
   * dueño lo revisó, lo imprimió y cuadró su efectivo, y meses después el número cambia solo.
   * Además ese `shift.update({ where: { id } })` iba sin `venueId` ni `status`.
   *
   * La regla vigente, unificada con los otros dos rieles (`refund.tpv`, `refund.mobile`):
   *   · con turno abierto  ⇒ el reembolso nace en el turno de HOY y se le descuenta a ÉSE;
   *   · sin turno abierto  ⇒ `shiftId = null` y NO SE TOCA NINGÚN TURNO CERRADO. Un pago con
   *     `shiftId` nulo es REATRIBUIBLE después (`scripts/reatribuir-cobros-al-turno.ts`);
   *     uno estampado en un turno cerrado con conteo es justo lo que ese script se niega a tocar.
   */
  describe('🔴 de qué turno sale el reembolso (fase 1: el turno es del negocio)', () => {
    const pagoConTurnoViejo = (over: Record<string, unknown> = {}) => ({
      id: 'payment-original',
      venueId: 'venue-1',
      status: TransactionStatus.COMPLETED,
      type: PaymentType.REGULAR,
      method: 'OTHER',
      source: 'APP',
      amount: 100,
      tipAmount: 0,
      orderId: 'order-1',
      // El cobro original vivió en un turno que YA cerró (ayer, otro cajero).
      shiftId: 'shift-viejo',
      merchantAccountId: null,
      processorData: {},
      fundsFlow: 'EXTERNAL_RECORDED',
      tenderTypeId: null,
      tenderRevision: null,
      tenderLabel: null,
      tenderCountsAsCash: false,
      tenderCaptureTip: false,
      tenderSatFormaPago: null,
      ...over,
    })

    const reembolsar = (over: Record<string, unknown> = {}) =>
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        amount: 5000, // $50.00
        reason: 'RETURNED_GOODS',
        ...over,
      })

    beforeEach(() => {
      // `jest.clearAllMocks()` NO vacía la cola de `mockResolvedValueOnce` (ver el comentario
      // del describe de tender): sin este reset, un Once heredado rompe el caso sin culpa suya.
      prismaMock.$queryRaw.mockReset()
      prismaMock.payment.create.mockResolvedValue({ id: 'refund-turno-1' })
      prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as never)
    })

    it('CON turno abierto: el reembolso nace en el turno del NEGOCIO y le descuenta a ÉSE, no al del cobro', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoConTurnoViejo()]).mockResolvedValueOnce([])
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-negocio', status: 'OPEN' } as never)

      // 🔴 A propósito SIN `staffId`: antes de la fase 1, la guarda `if (input.staffId)`
      // se saltaba el lookup entero y este reembolso caía en 'shift-viejo'.
      await reembolsar()

      // (i) el turno se busca por NEGOCIO. Igualdad EXACTA del `where`, no `objectContaining`:
      //     con él, volver a colar `staffId` seguiría pasando.
      expect(prismaMock.shift.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue-1', endTime: null } }))

      // (ii) el Payment del reembolso se ata al turno de HOY, no al del cobro original.
      const data = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(data.shiftId).toBe('shift-negocio')
      expect(data.processorData).toMatchObject({ shiftBackfilled: true })
      expect(data.processorData.shiftAttributionStatus).toBeUndefined()
      expect(data.processorData.shiftAttributionPendingReason).toBeUndefined()

      // (iii) y el descuento va a ESE turno: $50 fuera de la caja de hoy. Es un CLAIM condicional,
      //       no un `update` por id: acotado al venue y al estado OPEN, igual que los otros dos
      //       rieles. Sin `venueId` el `where` aceptaba el turno de OTRO negocio.
      expect(prismaMock.shift.update).not.toHaveBeenCalled()
      expect(prismaMock.shift.updateMany).toHaveBeenCalledTimes(1)
      const upd = prismaMock.shift.updateMany.mock.calls.at(-1)![0]
      expect(upd.where).toEqual({ id: 'shift-negocio', venueId: 'venue-1', status: 'OPEN', endTime: null })
      expect(upd.data.totalSales.decrement.toString()).toBe('50')
      // Sin propina reembolsada, `totalTips` ni se toca (el código lo omite del `data`).
      expect(upd.data.totalTips).toBeUndefined()
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    })

    it('🔴 SIN turno abierto: el reembolso queda SIN turno y no se toca el turno CERRADO del cobro', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoConTurnoViejo()]).mockResolvedValueOnce([])
      prismaMock.shift.findFirst.mockResolvedValue(null)

      await reembolsar()

      const data = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(data.shiftId).toBeUndefined()
      expect(data.processorData).toMatchObject({ shiftBackfilled: false })
      expect(data.processorData.shiftAttributionStatus).toBeUndefined()
      expect(data.processorData.shiftAttributionPendingReason).toBeUndefined()

      // Reescribir los totales de un corte que alguien ya firmó es lo único que no se puede hacer.
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.shift.update).not.toHaveBeenCalled()
    })

    it('🔴 si el turno cerró entre la lectura y el claim, el reembolso entra SIN turno', async () => {
      // El claim devuelve 0 filas. Estampar el `shiftId` igual dejaría un REFUND colgando de un
      // turno al que nunca se le restó: un recálculo desde los pagos discreparía de su propio
      // `totalSales` por el monto del reembolso.
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoConTurnoViejo()]).mockResolvedValueOnce([])
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-negocio', status: 'OPEN' } as never)
      prismaMock.shift.updateMany.mockResolvedValue({ count: 0 } as never)

      await reembolsar()

      const data = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(data.shiftId).toBeUndefined()
      expect(data.processorData).toMatchObject({ shiftBackfilled: false })
      expect(data.processorData.shiftAttributionStatus).toBeUndefined()
      expect(data.processorData.shiftAttributionPendingReason).toBeUndefined()
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityId: 'refund-turno-1',
            venueId: 'venue-1',
            data: expect.objectContaining({
              reason: 'CLAIM_LOST',
              candidateShiftId: 'shift-negocio',
              observedShiftStatus: 'OPEN',
              channel: 'issueRefund',
              amountPesos: '-50.00',
              tipPesos: '0.00',
            }),
          }),
        }),
      )
    })

    it('CLOSING: conserva venta+propina fuera del corte y deja una conciliación atómica exacta', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoConTurnoViejo({ tipAmount: 20 })]).mockResolvedValueOnce([])
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-closing', status: 'CLOSING' } as never)

      await reembolsar({ amount: 6000, tipRefundCents: 1000, staffId: 'staff-9' })

      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
      const data = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(data.shiftId).toBeUndefined()
      expect(data.processorData).toMatchObject({ shiftBackfilled: false })
      expect(data.processorData.shiftAttributionStatus).toBeUndefined()
      expect(data.processorData.shiftAttributionPendingReason).toBeUndefined()
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
        data: {
          action: 'PAYMENT_WITHOUT_SHIFT',
          entity: 'Payment',
          entityId: 'refund-turno-1',
          staffId: 'staff-9',
          venueId: 'venue-1',
          data: {
            status: 'PENDING',
            reason: 'SHIFT_NOT_OPEN',
            candidateShiftId: 'shift-closing',
            observedShiftStatus: 'CLOSING',
            paymentId: 'refund-turno-1',
            orderId: 'order-1',
            channel: 'issueRefund',
            amountPesos: '-50.00',
            tipPesos: '-10.00',
            totalPesos: '-60.00',
          },
        },
      })
      expect(prismaMock.payment.create.mock.invocationCallOrder.at(-1)).toBeLessThan(
        prismaMock.activityLog.create.mock.invocationCallOrder[0],
      )
    })

    it('sin candidato deja la señal común NO_SHIFT', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoConTurnoViejo()]).mockResolvedValueOnce([])
      prismaMock.shift.findFirst.mockResolvedValue(null)

      await reembolsar()

      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'PAYMENT_WITHOUT_SHIFT',
            data: expect.objectContaining({ reason: 'NO_SHIFT', channel: 'issueRefund' }),
          }),
        }),
      )
    })

    it('acumulado largo con filas incompletas: conserva el split default y fuerza pendiente aun con OPEN', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([pagoConTurnoViejo({ tipAmount: 20, processorData: { refundedAmountCents: 6000 } })])
        .mockResolvedValueOnce([
          {
            id: 'refund-clasificado-parcial',
            amount: -20,
            tipAmount: 0,
            processorData: {},
            createdAt: new Date('2026-09-03T10:00:00.000Z'),
            status: TransactionStatus.COMPLETED,
          },
        ])
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-negocio', status: 'OPEN' } as never)

      await reembolsar({ amount: 3000 })

      const refund = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(refund.amount.toFixed(2)).toBe('-25.00')
      expect(refund.tipAmount.toFixed(2)).toBe('-5.00')
      expect(refund.netAmount.toFixed(2)).toBe('-30.00')
      expect(refund.shiftId ?? null).toBeNull()
      expect(refund.processorData).toMatchObject({
        amountCents: 3000,
        shiftBackfilled: false,
        shiftAttributionPendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
      })
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityId: 'refund-turno-1',
            data: expect.objectContaining({
              reason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
              candidateShiftId: 'shift-negocio',
              observedShiftStatus: 'OPEN',
              channel: 'issueRefund',
              amountPesos: '-25.00',
              tipPesos: '-5.00',
              shiftAttributionStatus: 'PENDING',
              unclassifiedPriorRefundPesos: '40.00',
            }),
          }),
        }),
      )
    })

    it('acumulado largo sin filas: item refund queda 100% venta, sin turno y con pendiente aunque no haya candidato', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([pagoConTurnoViejo({ tipAmount: 20, processorData: { refundedAmountCents: 6000 } })])
        .mockResolvedValueOnce([])
      prismaMock.orderItem.findMany
        .mockResolvedValueOnce([
          {
            id: 'oi-1',
            productId: 'prod-1',
            productName: 'Producto',
            quantity: 1,
            total: new Decimal(20),
            orderPromotionId: null,
          },
        ])
        .mockResolvedValueOnce([{ id: 'oi-1', orderPromotionId: null, total: new Decimal(20) }])
      prismaMock.shift.findFirst.mockResolvedValue(null)

      await issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        items: [{ orderItemId: 'oi-1', quantity: 1 }],
        reason: 'RETURNED_GOODS',
      })

      const refund = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(refund.amount.toFixed(2)).toBe('-20.00')
      expect(refund.tipAmount.toFixed(2)).toBe('0.00')
      expect(refund.netAmount.toFixed(2)).toBe('-20.00')
      expect(refund.shiftId ?? null).toBeNull()
      expect(refund.processorData).toMatchObject({
        amountCents: 2000,
        shiftBackfilled: false,
        shiftAttributionPendingReason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
      })
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            data: expect.objectContaining({
              reason: 'UNCLASSIFIED_REFUND_COMPONENT_HISTORY',
              amountPesos: '-20.00',
              tipPesos: '0.00',
              shiftAttributionStatus: 'PENDING',
              unclassifiedPriorRefundPesos: '60.00',
            }),
          }),
        }),
      )
    })

    it('componente agotado: si la propina ya se devolvió, rebalancea el override a venta y decrementa sólo venta', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoConTurnoViejo({ tipAmount: 20 })]).mockResolvedValueOnce([
        {
          id: 'refund-tip-previo',
          amount: 0,
          tipAmount: -20,
          processorData: {},
          createdAt: new Date('2026-09-03T10:00:00.000Z'),
          status: TransactionStatus.COMPLETED,
        },
      ])
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-negocio', status: 'OPEN' } as never)

      await reembolsar({ amount: 2000, tipRefundCents: 2000 })

      const refund = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(refund.amount.toFixed(2)).toBe('-20.00')
      expect(refund.tipAmount.toFixed(2)).toBe('0.00')

      const decremento = prismaMock.shift.updateMany.mock.calls.at(-1)![0].data
      expect(decremento.totalSales.decrement.toFixed(2)).toBe('20.00')
      expect(decremento.totalTips).toBeUndefined()
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
    })

    it('componente agotado: si la venta ya se devolvió, rebalancea el default a propina y audita ese split post-corte', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoConTurnoViejo({ tipAmount: 20 })]).mockResolvedValueOnce([
        {
          id: 'refund-venta-previo',
          amount: -100,
          tipAmount: 0,
          processorData: {},
          createdAt: new Date('2026-09-03T10:00:00.000Z'),
          status: TransactionStatus.COMPLETED,
        },
      ])
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-closing', status: 'CLOSING' } as never)

      await reembolsar({ amount: 2000 })

      const refund = prismaMock.payment.create.mock.calls.at(-1)![0].data
      expect(refund.amount.toFixed(2)).toBe('0.00')
      expect(refund.tipAmount.toFixed(2)).toBe('-20.00')
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityId: 'refund-turno-1',
            data: expect.objectContaining({
              reason: 'SHIFT_NOT_OPEN',
              channel: 'issueRefund',
              amountPesos: '0.00',
              tipPesos: '-20.00',
            }),
          }),
        }),
      )
    })

    it('componente agotado: un refund por artículo no convierte mercancía en propina', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([pagoConTurnoViejo({ tipAmount: 20 })]).mockResolvedValueOnce([
        {
          id: 'refund-venta-previo',
          amount: -100,
          tipAmount: 0,
          processorData: {},
          createdAt: new Date('2026-09-03T10:00:00.000Z'),
          status: TransactionStatus.COMPLETED,
        },
      ])
      prismaMock.orderItem.findMany
        .mockResolvedValueOnce([
          {
            id: 'oi-1',
            productId: 'prod-1',
            productName: 'Producto',
            quantity: 1,
            total: new Decimal(20),
            orderPromotionId: null,
          },
        ])
        .mockResolvedValueOnce([{ id: 'oi-1', orderPromotionId: null, total: new Decimal(20) }])

      await expect(
        issueRefund({
          venueId: 'venue-1',
          paymentId: 'payment-original',
          items: [{ orderItemId: 'oi-1', quantity: 1 }],
          reason: 'RETURNED_GOODS',
        }),
      ).rejects.toThrow(/remaining refundable sale amount/i)

      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    })

    it('rollback stateful OPEN: un fallo después del Payment revierte decremento y refund sin audit global', async () => {
      const committed = { totalSales: 300, totalTips: 40, payments: [] as any[], audits: [] as any[] }
      let stagedAntesDelFallo: typeof committed | null = null

      prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
        const staged = {
          totalSales: committed.totalSales,
          totalTips: committed.totalTips,
          payments: [...committed.payments],
          audits: [...committed.audits],
        }
        const tx = {
          $queryRaw: jest
            .fn()
            .mockResolvedValueOnce([{ id: 'order-1' }])
            .mockResolvedValueOnce([pagoConTurnoViejo({ tipAmount: 20 })])
            .mockResolvedValueOnce([]),
          shift: {
            findFirst: jest.fn().mockResolvedValue({ id: 'shift-open', status: 'OPEN' }),
            updateMany: jest.fn().mockImplementation(async ({ data }: any) => {
              staged.totalSales -= Number(data.totalSales.decrement)
              staged.totalTips -= Number(data.totalTips.decrement)
              return { count: 1 }
            }),
          },
          payment: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              const row = { id: 'refund-staged', ...data }
              staged.payments.push(row)
              return row
            }),
            update: jest.fn().mockImplementation(async () => {
              stagedAntesDelFallo = { ...staged, payments: [...staged.payments], audits: [...staged.audits] }
              throw new Error('fallo posterior al Payment OPEN')
            }),
          },
          activityLog: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              staged.audits.push(data)
              return { id: 'audit-staged' }
            }),
          },
          venueSettings: { findUnique: jest.fn().mockResolvedValue({ enableShifts: true }) },
          venueTransaction: { create: jest.fn() },
        }

        const result = await callback(tx)
        Object.assign(committed, staged)
        return result
      })

      await expect(reembolsar({ amount: 6000, tipRefundCents: 1000 })).rejects.toThrow('fallo posterior al Payment OPEN')

      expect(stagedAntesDelFallo).toEqual({ totalSales: 250, totalTips: 30, payments: [expect.any(Object)], audits: [] })
      expect(committed).toEqual({ totalSales: 300, totalTips: 40, payments: [], audits: [] })
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })

    it('rollback stateful CLOSING: un fallo después del audit revierte refund y conciliación sin audit global', async () => {
      const committed = { payments: [] as any[], audits: [] as any[] }
      let stagedAntesDelFallo: typeof committed | null = null

      prismaMock.$transaction.mockImplementationOnce(async (callback: any) => {
        const staged = { payments: [...committed.payments], audits: [...committed.audits] }
        const tx = {
          $queryRaw: jest
            .fn()
            .mockResolvedValueOnce([{ id: 'order-1' }])
            .mockResolvedValueOnce([pagoConTurnoViejo({ tipAmount: 20 })])
            .mockResolvedValueOnce([]),
          shift: {
            findFirst: jest.fn().mockResolvedValue({ id: 'shift-closing', status: 'CLOSING' }),
            updateMany: jest.fn(),
          },
          payment: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              const row = { id: 'refund-staged', ...data }
              staged.payments.push(row)
              return row
            }),
            update: jest.fn().mockImplementation(async () => {
              stagedAntesDelFallo = { payments: [...staged.payments], audits: [...staged.audits] }
              throw new Error('fallo posterior al audit CLOSING')
            }),
          },
          activityLog: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              staged.audits.push(data)
              return { id: 'audit-staged' }
            }),
          },
          venueSettings: { findUnique: jest.fn().mockResolvedValue({ enableShifts: true }) },
          venueTransaction: { create: jest.fn() },
        }

        const result = await callback(tx)
        Object.assign(committed, staged)
        return result
      })

      await expect(reembolsar({ amount: 6000, tipRefundCents: 1000 })).rejects.toThrow('fallo posterior al audit CLOSING')

      expect(stagedAntesDelFallo).toEqual({ payments: [expect.any(Object)], audits: [expect.any(Object)] })
      expect(committed).toEqual({ payments: [], audits: [] })
      expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
      expect(logAction).not.toHaveBeenCalled()
    })
  })
})
