import { PaymentType, TransactionStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { issueRefund, listRefundsForPayment, TOPE_DEVOLUCIONES_POR_COBRO } from '@/services/dashboard/refund.dashboard.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'
import { TOPES_POR_ORDEN } from '@/services/fiscal/librosDeOrdenes'

// Fase 3 (A2): la devolución del dashboard encola su reverso de comisión DENTRO de su transacción. Esta suite prueba otra
// cosa y no siembra lo que el encolado lee; el resto del módulo (lo usa el costo diferido) queda real.
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueueRefundPaymentEffectsInTx: jest.fn().mockResolvedValue(undefined),
}))

// logAction is globally mocked to a no-op jest.fn in tests/__helpers__/setup.ts,
// so we assert the audit dual-write on the mock itself (not prismaMock.activityLog).

jest.mock('@/services/dashboard/rawMaterial.service', () => ({
  adjustStock: jest.fn(),
}))

const ORDER_GENERATION = new Date('2026-09-04T09:00:00.000Z')

// C2 A-1: la cuenta de la orden que lee `leerCobradoDeLaOrden` (cabecera de descuento y sus filas). Por default, sin descuentos.
let descuentosDeLaCuenta: Array<{ amount: Decimal; reparto: unknown }> = []
// C2 A-1 ronda 1 (I1): las devoluciones de TODA la orden (todos sus cobros). null = las del propio cobro (una cuenta de un solo cobro).
let devolucionesDeLaOrden: Array<{ id: string; processorData: unknown }> | null = null
// C2 · OF-2 (A-1 N1): el SQL de esa lectura, tal cual lo armó el servicio (para fijar su `WHERE`).
let sqlDeLaOrden: string | null = null

describe('refund.dashboard.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    descuentosDeLaCuenta = []
    devolucionesDeLaOrden = null
    sqlDeLaOrden = null
    prismaMock.order.findUnique.mockResolvedValue({ discountAmount: new Decimal(0), contratoDePrecio: null, originSystem: null })
    prismaMock.payment.findFirst.mockResolvedValue({
      orderId: 'order-1',
      order: { updatedAt: ORDER_GENERATION },
    } as any)
    prismaMock.$transaction.mockImplementation(async (callback: any) => {
      // El lock de Order comparte `$queryRaw` con las dos lecturas Payment del servicio.
      // Interceptarlo aquí mantiene las colas `.mockResolvedValueOnce` enfocadas en Payment.
      let devolucionesDelCobro: unknown[] = []
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
        // C2 A-1: los descuentos de la cuenta que lee el cargador de lo cobrado (proyección del libro). Por default, ninguno.
        if (sql.includes('FROM "OrderDiscount"')) return descuentosDeLaCuenta
        // C2 A-1 ronda 1: lo ya devuelto en TODA la orden. Por default, lo del cobro (lo que la prueba sembró en su cola).
        if (sql.includes("jsonb_build_object('refundedItems'")) {
          sqlDeLaOrden = sql
          return devolucionesDeLaOrden ?? devolucionesDelCobro
        }
        const r = await (prismaMock.$queryRaw as any)(...args)
        if (sql.includes(`->>'originalPaymentId'`)) devolucionesDelCobro = Array.isArray(r) ? r : []
        return r
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
      expect(prismaMock.shift.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { venueId: 'venue-1', endTime: null, status: { in: ['OPEN', 'CLOSING'] } } }),
      )

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

    /**
     * 🔴 CAMBIÓ EL 2026-09-12, por decisión del founder con una auditoría independiente
     * (Codex gpt-6-astra) enfrente. Esta prueba fijaba el REBALANCEO como correcto: si el
     * cajero pedía «devuelve $20, todo de propina» y la propina ya se había devuelto, el
     * servidor sacaba los $20 del CONSUMO y los devolvía igual.
     *
     * Era correcto para el mesero —nunca se le quita propina de más— e incorrecto para el
     * NEGOCIO: «todo de propina» es una instrucción exacta, y sustituirla por consumo cambia
     * en silencio lo que el cajero autorizó. El caso real es un reintento —pantalla lenta,
     * red intermitente—: el cliente se lleva $40 y el negocio pierde $20 sin que nadie lo vea.
     *
     * Ahora se rechaza y se dice qué se devolvió antes. La prueba conserva su escenario; lo
     * que cambia es el veredicto.
     */
    it('componente agotado: si la propina ya se devolvió, se RECHAZA en vez de cargarlo a la venta', async () => {
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

      await expect(reembolsar({ amount: 2000, tipRefundCents: 2000 })).rejects.toThrow(/propina/i)

      // Y lo que de verdad importa: no se escribió NADA. Ni el reembolso, ni el decremento
      // del turno. El dinero del negocio se queda donde estaba.
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
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

  describe('🔴 reembolso por artículos: el cajero elige devolver la propina (Testarudo, 28-sep-2026)', () => {
    const cobro = (over: Record<string, unknown> = {}) => ({
      id: 'payment-original',
      venueId: 'venue-1',
      status: TransactionStatus.COMPLETED,
      type: PaymentType.REGULAR,
      method: 'CASH',
      source: 'APP',
      amount: 145,
      tipAmount: 14.5,
      orderId: 'order-1',
      shiftId: null,
      merchantAccountId: null,
      processorData: {},
      fundsFlow: null,
      tenderTypeId: null,
      tenderCountsAsCash: null,
      ...over,
    })
    const lineas = [
      { id: 'oi-1', productId: 'p-1', productName: 'FLAT WHITE', quantity: 1, total: new Decimal(80), orderPromotionId: null },
      { id: 'oi-2', productId: 'p-2', productName: 'ROLL DE ALMENDRA', quantity: 1, total: new Decimal(65), orderPromotionId: null },
    ]
    const conLineas = (seleccionadas: string[]) => {
      prismaMock.orderItem.findMany
        .mockResolvedValueOnce(lineas.filter(l => seleccionadas.includes(l.id)))
        .mockResolvedValueOnce(lineas.map(l => ({ id: l.id, orderPromotionId: null, total: l.total })))
    }
    const reembolsar = (ids: string[], over: Record<string, unknown> = {}) =>
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        items: ids.map(orderItemId => ({ orderItemId, quantity: 1 })),
        reason: 'ACCIDENTAL_CHARGE' as any,
        staffId: 'staff-9',
        ...over,
      })
    const filaReembolso = () => prismaMock.payment.create.mock.calls[0][0].data
    const propinaPreviaDe = (pesos: number) => ({
      id: 'refund-tip-previo',
      amount: 0,
      tipAmount: -pesos,
      processorData: {},
      createdAt: new Date('2026-09-28T10:00:00.000Z'),
      status: TransactionStatus.COMPLETED,
    })

    beforeEach(() => {
      // `clearAllMocks` NO vacía las colas de `mockResolvedValueOnce` (ver el describe de turno ~:757).
      prismaMock.$queryRaw.mockReset()
      prismaMock.orderItem.findMany.mockReset()
      prismaMock.payment.create.mockResolvedValue({ id: 'refund-articulos-1' })
      prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as never)
    })

    it('P1 todos los artículos + la propina: la fila la separa, el total la suma, turno y cajón cuadran', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([])
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'shift-negocio', status: 'OPEN' } as never)
      conLineas(['oi-1', 'oi-2'])

      const result = await reembolsar(['oi-1', 'oi-2'], { tipRefundCents: 1450 })

      expect(Number(filaReembolso().amount)).toBe(-145)
      expect(Number(filaReembolso().tipAmount)).toBe(-14.5)
      expect(result.amount).toBe(159.5)
      expect(result.remainingRefundable).toBe(0)
      expect(Number((prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0].amount)).toBe(159.5)
      // El turno baja venta y propina POR SEPARADO (patrón de la prueba ~:790).
      const upd = prismaMock.shift.updateMany.mock.calls.at(-1)![0]
      expect(upd.data.totalSales.decrement.toString()).toBe('145')
      expect(upd.data.totalTips.decrement.toString()).toBe('14.5')
      // El acumulado del original es venta + propina (mismo aserto que «updates cumulative refunded cents»).
      expect(prismaMock.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            processorData: expect.objectContaining({ refundedAmount: 159.5, refundedAmountCents: 15950 }),
          }),
        }),
      )
      // La transacción de dinero lleva el TOTAL devuelto en negativo (venta + propina).
      const vtx = prismaMock.venueTransaction.create.mock.calls[0][0].data
      expect(Number(vtx.grossAmount)).toBe(-159.5)
      expect(Number(vtx.netAmount)).toBe(-159.5)
    })

    it('sin tipRefundCents el reembolso por artículos sigue siendo 100 % venta', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([])
      conLineas(['oi-1', 'oi-2'])

      const result = await reembolsar(['oi-1', 'oi-2'])

      // `-0` como Decimal: `toFixed` lo normaliza a '0.00' (Number(-0) haría fallar `toBe(0)` por Object.is).
      expect(filaReembolso().tipAmount.toFixed(2)).toBe('0.00')
      expect(result.amount).toBe(145)
    })

    it('reembolso parcial con la casilla marcada: esos artículos + la propina, con cualquier motivo', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([])
      conLineas(['oi-2'])

      const result = await reembolsar(['oi-2'], { tipRefundCents: 1450, reason: 'RETURNED_GOODS' })

      expect(Number(filaReembolso().amount)).toBe(-65)
      expect(Number(filaReembolso().tipAmount)).toBe(-14.5)
      expect(result.amount).toBe(79.5)
    })

    it('🔴 más propina de la que queda se RECHAZA sin escribir nada (la pantalla prometió un total)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([propinaPreviaDe(5)])
      conLineas(['oi-1', 'oi-2'])

      await expect(reembolsar(['oi-1', 'oi-2'], { tipRefundCents: 1450 })).rejects.toThrow(/propina/i)

      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    })

    it('🔴 parcial que CABE en el total pero no en la propina restante también se rechaza (R2)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([propinaPreviaDe(5)])
      conLineas(['oi-2'])

      // $65 + $14.50 = $79.50 cabe en los $154.50 que quedan, pero de propina sólo quedan $9.50.
      await expect(reembolsar(['oi-2'], { tipRefundCents: 1450 })).rejects.toThrow(/propina/i)

      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('🔴 con históricos SIN clasificar, la propina que consta devuelta no se vuelve a devolver (R1)', async () => {
      // Acumulado del original $24.50; la fila previa explica $14.50 de propina ⇒ $10 sin clasificar.
      prismaMock.$queryRaw
        .mockResolvedValueOnce([cobro({ processorData: { refundedAmountCents: 2450 } })])
        .mockResolvedValueOnce([propinaPreviaDe(14.5)])
      conLineas(['oi-2'])

      await expect(reembolsar(['oi-2'], { tipRefundCents: 1450 })).rejects.toThrow(/propina/i)

      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('con $5 de propina ya devueltos, pedir la restante ($9.50) funciona', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([propinaPreviaDe(5)])
      conLineas(['oi-1', 'oi-2'])

      const result = await reembolsar(['oi-1', 'oi-2'], { tipRefundCents: 950 })

      expect(Number(filaReembolso().tipAmount)).toBe(-9.5)
      expect(result.amount).toBe(154.5)
    })
  })

  describe('🔴 escoger con qué se devuelve (refundMethod, 30-sep-2026)', () => {
    const cobro = (over: Record<string, unknown> = {}) => ({
      id: 'payment-original',
      venueId: 'venue-1',
      status: TransactionStatus.COMPLETED,
      type: PaymentType.REGULAR,
      method: 'BANK_TRANSFER',
      source: 'OTHER',
      amount: 200,
      tipAmount: 0,
      orderId: 'order-1',
      shiftId: null,
      merchantAccountId: null,
      processorData: {},
      fundsFlow: 'EXTERNAL_RECORDED',
      externalSource: null,
      tenderTypeId: 'tender-transf',
      tenderRevision: 1,
      tenderLabel: 'Transferencia',
      tenderCountsAsCash: false,
      tenderCaptureTip: true,
      tenderSatFormaPago: '03',
      tenderCommissionPercent: null,
      ...over,
    })
    const reembolsar = (over: Record<string, unknown> = {}) =>
      issueRefund({
        venueId: 'venue-1',
        paymentId: 'payment-original',
        amount: 15000,
        reason: 'RETURNED_GOODS',
        staffId: 'staff-9',
        ...over,
      })
    const dataDelReembolso = () => prismaMock.payment.create.mock.calls[0][0].data

    beforeEach(() => {
      prismaMock.$queryRaw.mockReset()
      prismaMock.payment.create.mockResolvedValue({ id: 'refund-escogido-1' })
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue({ id: 'session-1' })
    })

    it('transferencia devuelta en EFECTIVO: la fila dice CASH/CASH_DRAWER, sin tender, y sale de la caja', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([])
      await reembolsar({ refundMethod: 'CASH' })
      const data = dataDelReembolso()
      expect(data).toMatchObject({ method: 'CASH', fundsFlow: 'CASH_DRAWER' })
      expect(data.tenderTypeId).toBeUndefined()
      expect(data.tenderLabel).toBeUndefined()
      expect(data.tenderSatFormaPago).toBeUndefined()
      expect(data.processorData).toMatchObject({ originalMethod: 'BANK_TRANSFER' })
      const ev = (prismaMock as any).cashDrawerEvent.createMany.mock.calls[0][0].data[0]
      expect(ev).toMatchObject({ type: 'PAY_OUT' })
      expect(Number(ev.amount)).toBe(150)
    })

    it('efectivo devuelto por TRANSFERENCIA: BANK_TRANSFER/EXTERNAL_RECORDED y NO toca la caja', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([
          cobro({
            method: 'CASH',
            source: 'APP',
            fundsFlow: 'CASH_DRAWER',
            tenderTypeId: null,
            tenderLabel: null,
            tenderSatFormaPago: null,
            tenderRevision: null,
            tenderCountsAsCash: null,
            tenderCaptureTip: null,
          }),
        ])
        .mockResolvedValueOnce([])
      await reembolsar({ refundMethod: 'BANK_TRANSFER' })
      expect(dataDelReembolso()).toMatchObject({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' })
      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })

    it('🔴 un vale que ya entra al cajón + «Efectivo de la caja» = como hoy (hereda el tender)', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([
          cobro({
            method: 'OTHER',
            fundsFlow: 'CASH_DRAWER',
            tenderTypeId: 'tender-vale',
            tenderLabel: 'Vale',
            tenderCountsAsCash: true,
            tenderSatFormaPago: '08',
          }),
        ])
        .mockResolvedValueOnce([])
      await reembolsar({ refundMethod: 'CASH' })
      expect(dataDelReembolso()).toMatchObject({ method: 'OTHER', tenderTypeId: 'tender-vale', fundsFlow: 'CASH_DRAWER' })
    })

    it('🔴 un vale que cuenta como efectivo + BANK_TRANSFER ⇒ BANK_TRANSFER/EXTERNAL_RECORDED, sin tender y SIN PAY_OUT', async () => {
      prismaMock.$queryRaw
        .mockResolvedValueOnce([
          cobro({
            method: 'OTHER',
            fundsFlow: 'CASH_DRAWER',
            tenderTypeId: 'tender-vale',
            tenderLabel: 'Vale',
            tenderCountsAsCash: true,
            tenderSatFormaPago: '08',
          }),
        ])
        .mockResolvedValueOnce([])
      await reembolsar({ refundMethod: 'BANK_TRANSFER' })
      const data = dataDelReembolso()
      expect(data).toMatchObject({ method: 'BANK_TRANSFER', fundsFlow: 'EXTERNAL_RECORDED' })
      expect(data.tenderTypeId).toBeUndefined()
      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })

    it('refundMethod igual al del cobro = como hoy (hereda tender y fundsFlow)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([])
      await reembolsar({ refundMethod: 'BANK_TRANSFER' })
      expect(dataDelReembolso()).toMatchObject({
        method: 'BANK_TRANSFER',
        fundsFlow: 'EXTERNAL_RECORDED',
        tenderTypeId: 'tender-transf',
        tenderLabel: 'Transferencia',
      })
    })

    it('sin refundMethod = como hoy, y la fila guarda originalMethod igual', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([])
      await reembolsar()
      expect(dataDelReembolso()).toMatchObject({ method: 'BANK_TRANSFER', tenderTypeId: 'tender-transf' })
      expect(dataDelReembolso().processorData).toMatchObject({ originalMethod: 'BANK_TRANSFER' })
    })

    it.each([
      ['tarjeta', { method: 'CREDIT_CARD', source: 'TPV', fundsFlow: 'AVOQADO_PROCESSED', tenderTypeId: null, tenderSatFormaPago: null }],
      [
        'tarjeta de otra terminal',
        { method: 'OTHER', externalSource: 'Tarjeta (terminal externa)', tenderTypeId: null, tenderSatFormaPago: null },
      ],
    ])('🔴 %s + refundMethod ⇒ 400 y no escribe nada', async (_n, over) => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(over)]).mockResolvedValueOnce([])
      await expect(reembolsar({ refundMethod: 'CASH' })).rejects.toThrow('Este cobro sólo se devuelve por el mismo medio con que se pagó.')
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('caja cerrada: el reembolso en efectivo se emite igual, sin PAY_OUT', async () => {
      ;(prismaMock as any).cashDrawerSession.findFirst.mockResolvedValue(null)
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([])
      const r = await reembolsar({ refundMethod: 'CASH' })
      expect(r.status).toBe('COMPLETED')
      expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
    })

    it('la bitácora dice con qué se devolvió', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro()]).mockResolvedValueOnce([])
      await reembolsar({ refundMethod: 'CASH' })
      // Mismo espía que usa 'writes a REFUND_CREATED ActivityLog row…' en este archivo.
      expect(logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'REFUND_CREATED',
          data: expect.objectContaining({ refundMethod: 'CASH', originalMethod: 'BANK_TRANSFER' }),
        }),
      )
    })
  })
  // C2 A-1 (decisión A del founder, 9-oct; investigacion-bruto-vs-neto.md §1): cada artículo devuelve lo que COBRARON sus unidades —su
  // total menos su descuento propio y su parte de los descuentos de la cuenta—, no el bruto. Lo demás (topes, propina, cantidades) igual.
  describe('🔴 C2 A-1 · la devolución por artículos devuelve lo COBRADO, no el bruto', () => {
    const cobro = (amount: number, tipAmount = 0, processorData: Record<string, unknown> = {}) => ({
      id: 'payment-original',
      venueId: 'venue-1',
      status: TransactionStatus.COMPLETED,
      type: PaymentType.REGULAR,
      method: 'CASH',
      source: 'APP',
      amount,
      tipAmount,
      orderId: 'order-1',
      shiftId: null,
      merchantAccountId: null,
      processorData,
      fundsFlow: null,
      tenderTypeId: null,
      tenderCountsAsCash: null,
    })
    /** Un renglón al 16 % de $100 con lo que lee el cargador (`SELECT_RENGLON`) y lo que lee el escritor. */
    const linea = (id: string, o: Record<string, unknown> = {}) => ({
      id,
      orderId: 'order-1',
      productId: `p-${id}`,
      productName: id,
      quantity: 1,
      unitPrice: new Decimal(100),
      total: new Decimal(100),
      discountAmount: new Decimal(0),
      orderPromotionId: null,
      isCortesia: false,
      ivaTratamiento: null,
      product: { taxRate: new Decimal(0.16), ivaTratamiento: 'IVA_16' },
      ...o,
    })
    const espejo = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones })
    const dirigido = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, renglones })
    const cuenta = (renglones: Record<string, number>) => ({ v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones })
    /** La venta: sus renglones (el escritor pide los elegidos por id; el cargador, todos), la cabecera y las filas de descuento. */
    const venta = (lineas: Array<ReturnType<typeof linea>>, cabecera: number, filas: Array<{ amount: number; reparto: unknown }> = []) => {
      prismaMock.order.findUnique.mockResolvedValue({ discountAmount: new Decimal(cabecera), contratoDePrecio: null, originSystem: null })
      descuentosDeLaCuenta = filas.map(f => ({ amount: new Decimal(f.amount), reparto: f.reparto }))
      prismaMock.orderItem.findMany.mockImplementation(async (a: any) =>
        a?.where?.id?.in ? lineas.filter(l => a.where.id.in.includes(l.id)) : lineas,
      )
    }
    const reembolsar = (items: Array<{ orderItemId: string; quantity?: number }>, over: Record<string, unknown> = {}) =>
      issueRefund({ venueId: 'venue-1', paymentId: 'payment-original', items, reason: 'RETURNED_GOODS', staffId: 'staff-9', ...over })
    const filaReembolso = (i = 0) => prismaMock.payment.create.mock.calls[i][0].data

    beforeEach(() => {
      // `clearAllMocks` NO vacía las colas de `mockResolvedValueOnce` ni las implementaciones.
      prismaMock.$queryRaw.mockReset()
      prismaMock.orderItem.findMany.mockReset()
      prismaMock.payment.create.mockResolvedValue({ id: 'refund-neto-1' })
      prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as never)
    })
    afterEach(() => {
      prismaMock.orderItem.findMany.mockReset()
      prismaMock.orderItem.findMany.mockResolvedValue([])
    })

    it('🔴 E2 · A $100 −$10 propio + B $50 (cobro $140): devolver A regresa $90, y refundedItems dice $90', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(140)]).mockResolvedValueOnce([])
      venta([linea('A', { discountAmount: new Decimal(10) }), linea('B', { unitPrice: new Decimal(50), total: new Decimal(50) })], 10, [
        { amount: 10, reparto: espejo({ A: 1000 }) },
      ])

      const r = await reembolsar([{ orderItemId: 'A' }])

      expect(r.amount).toBe(90)
      expect(r.remainingRefundable).toBe(50)
      expect(Number(filaReembolso().amount)).toBe(-90)
      expect(filaReembolso().processorData.refundedItems).toEqual([
        expect.objectContaining({ orderItemId: 'A', quantity: 1, amountCents: 9000, amount: 90 }),
      ])
    })

    it('🔴 E3 · descuento de cuenta repartido 10/10 (A $100 + B $100 −$20, cobro $180): devolver A regresa $90', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(180)]).mockResolvedValueOnce([])
      venta([linea('A'), linea('B')], 20, [{ amount: 20, reparto: cuenta({ A: 1000, B: 1000 }) }])

      const r = await reembolsar([{ orderItemId: 'A' }])

      expect(r.amount).toBe(90)
      expect(filaReembolso().processorData.refundedItems[0]).toMatchObject({ amountCents: 9000, amount: 90 })
    })

    it('🔴 E3 · descuento de cuenta dirigido 100 % a A: devolver A regresa $80 (y B, después, sus $100)', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(180)]).mockResolvedValueOnce([])
      venta([linea('A'), linea('B')], 20, [{ amount: 20, reparto: dirigido({ A: 2000 }) }])

      expect((await reembolsar([{ orderItemId: 'A' }])).amount).toBe(80)
    })

    it('🔴 D8 sin reparto con varios IVA (café $116 al 16 % + grano $100 al 0 %, −$21.60): el café regresa $104.40', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(194.4)]).mockResolvedValueOnce([])
      venta(
        [
          linea('cafe', { unitPrice: new Decimal(116), total: new Decimal(116) }),
          linea('grano', { product: { taxRate: new Decimal(0), ivaTratamiento: 'IVA_0' } }),
        ],
        21.6,
        [{ amount: 21.6, reparto: null }],
      )

      expect((await reembolsar([{ orderItemId: 'cafe' }])).amount).toBe(104.4)
    })

    it('🔴 E1 · A $100 −$10 sola (cobro $90): antes 400 «exceeds remaining», ahora devuelve sus $90', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(90)]).mockResolvedValueOnce([])
      venta([linea('A', { discountAmount: new Decimal(10) })], 10, [{ amount: 10, reparto: espejo({ A: 1000 }) }])

      const r = await reembolsar([{ orderItemId: 'A' }])

      expect(r.amount).toBe(90)
      expect(r.remainingRefundable).toBe(0)
    })

    it('🔴 E1′ · con $10 de propina: sin propina devuelve $90 de venta; con la casilla, $90 + $10', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(90, 10)]).mockResolvedValueOnce([])
      venta([linea('A', { discountAmount: new Decimal(10) })], 10, [{ amount: 10, reparto: espejo({ A: 1000 }) }])
      const sinPropina = await reembolsar([{ orderItemId: 'A' }])
      expect(sinPropina.amount).toBe(90)
      expect(filaReembolso(0).tipAmount.toFixed(2)).toBe('0.00')

      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(90, 10)]).mockResolvedValueOnce([])
      const conPropina = await reembolsar([{ orderItemId: 'A' }], { tipRefundCents: 1000 })
      expect(conPropina.amount).toBe(100)
      expect(Number(filaReembolso(1).amount)).toBe(-90)
      expect(Number(filaReembolso(1).tipAmount)).toBe(-10)
    })

    it('🔴 E4 · cortesía bruta de la TPV (total $100, descuento $100) + B $150: devolver los dos regresa $150, no $250', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(150)]).mockResolvedValueOnce([])
      venta(
        [
          linea('regalo', { isCortesia: true, discountAmount: new Decimal(100) }),
          linea('B', { unitPrice: new Decimal(150), total: new Decimal(150) }),
        ],
        100,
      )

      const r = await reembolsar([{ orderItemId: 'regalo' }, { orderItemId: 'B' }])

      expect(r.amount).toBe(150)
      expect(filaReembolso().processorData.refundedItems).toEqual([
        expect.objectContaining({ orderItemId: 'regalo', amountCents: 0 }),
        expect.objectContaining({ orderItemId: 'B', amountCents: 15000 }),
      ])
    })

    it('🔴 E4 · la cortesía bruta de la TPV sola regresa $0 ⇒ el 400 de siempre «must be greater than zero», sin escribir nada', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(150)]).mockResolvedValueOnce([])
      venta(
        [
          linea('regalo', { isCortesia: true, discountAmount: new Decimal(100) }),
          linea('B', { unitPrice: new Decimal(150), total: new Decimal(150) }),
        ],
        100,
      )

      await expect(reembolsar([{ orderItemId: 'regalo' }])).rejects.toThrow('Refund amount must be greater than zero')
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('🔴 A-R3 · composición no atribuible (descuento sin reparto mayor que lo vendido) ⇒ 400 «haz la devolución por importe» y nada escrito', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(200)]).mockResolvedValueOnce([])
      venta([linea('A'), linea('B')], 300, [{ amount: 300, reparto: null }])

      const fallo = reembolsar([{ orderItemId: 'A' }])
      await expect(fallo).rejects.toThrow(
        'Esta venta tiene descuentos que no se pueden repartir por artículo; haz la devolución por importe.',
      )
      await expect(fallo).rejects.toMatchObject({ statusCode: 400, code: 'REFUND_ITEMS_NOT_ATTRIBUTABLE' })
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
      expect(prismaMock.payment.update).not.toHaveBeenCalled()
    })

    it('🔴 un artículo elegido que el cargador no vio (nunca pasa bajo el candado) ⇒ el mismo 400 y nada escrito, nunca un monto inventado', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(200)]).mockResolvedValueOnce([])
      venta([linea('A'), linea('B')], 0)
      prismaMock.orderItem.findMany.mockImplementation(async (a: any) => (a?.where?.id?.in ? [linea('X')] : [linea('A'), linea('B')]))

      await expect(reembolsar([{ orderItemId: 'X' }])).rejects.toMatchObject({ statusCode: 400, code: 'REFUND_ITEMS_NOT_ATTRIBUTABLE' })
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('🔴 residuo: 3 unidades que cobraron $10 ($12 −$2) devueltas una por una regresan 3.34 + 3.33 + 3.33 = $10.00 exactos', async () => {
      venta([linea('A', { quantity: 3, unitPrice: new Decimal(4), total: new Decimal(12), discountAmount: new Decimal(2) })], 2, [
        { amount: 2, reparto: espejo({ A: 200 }) },
      ])
      const previos: any[] = []
      const devueltos: number[] = []
      for (let i = 0; i < 3; i++) {
        prismaMock.$queryRaw.mockResolvedValueOnce([cobro(10)]).mockResolvedValueOnce([...previos])
        const r = await reembolsar([{ orderItemId: 'A', quantity: 1 }])
        const fila = filaReembolso(i)
        devueltos.push(fila.processorData.refundedItems[0].amountCents)
        previos.push({
          id: `refund-${i}`,
          amount: fila.amount,
          tipAmount: fila.tipAmount,
          createdAt: new Date(`2026-10-09T1${i}:00:00.000Z`),
          status: TransactionStatus.COMPLETED,
          processorData: fila.processorData,
        })
        if (i === 2) expect(r.remainingRefundable).toBe(0)
      }
      expect(devueltos).toEqual([334, 333, 333])
      expect(devueltos.reduce((a, b) => a + b, 0)).toBe(1000)
    })

    // Ronda 1 (I1, revisión de A-1): en una cuenta DIVIDIDA lo ya devuelto de un artículo se cuenta sobre TODA la orden, no por cobro.
    it('🔴 I1 · cuenta dividida (A $100 + B $100 en dos cobros de $100): A se devuelve UNA vez; por el otro cobro se rechaza y B sí sale', async () => {
      venta([linea('A'), linea('B')], 0)
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(100)]).mockResolvedValueOnce([])
      expect((await reembolsar([{ orderItemId: 'A' }])).amount).toBe(100)
      // El segundo cobro no tiene devoluciones propias, pero la ORDEN ya devolvió A por el primero.
      devolucionesDeLaOrden = [{ id: 'refund-p1', processorData: filaReembolso(0).processorData }]

      prismaMock.$queryRaw.mockResolvedValueOnce([{ ...cobro(100), id: 'payment-2' }]).mockResolvedValueOnce([])
      await expect(reembolsar([{ orderItemId: 'A' }], { paymentId: 'payment-2' })).rejects.toThrow(
        'Este artículo («A») ya se devolvió en otro cobro de la misma cuenta; quedan 0 de 1 por devolver.',
      )
      expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)

      prismaMock.$queryRaw.mockResolvedValueOnce([{ ...cobro(100), id: 'payment-2' }]).mockResolvedValueOnce([])
      expect((await reembolsar([{ orderItemId: 'B' }], { paymentId: 'payment-2' })).amount).toBe(100)
    })

    // C2 · OF-2 (A-1 N1): lo ya devuelto de la ORDEN no filtra por `status` A PROPÓSITO (como la lectura por cobro): una devolución por
    // artículos no completada sigue contando en CANTIDADES, o el artículo se podría volver a devolver por otro cobro. Agregar
    // `status = 'COMPLETED'` a ese `WHERE` tiene que hacer caer esta prueba.
    it('control — la lectura de lo ya devuelto en la ORDEN filtra por negocio, orden y tipo, y NUNCA por status', async () => {
      venta([linea('A'), linea('B')], 0)
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(100)]).mockResolvedValueOnce([])
      await reembolsar([{ orderItemId: 'A' }])
      const where = sqlDeLaOrden!.slice(sqlDeLaOrden!.indexOf('WHERE'), sqlDeLaOrden!.indexOf('ORDER BY'))
      expect(where).toMatch(/"venueId" = \?/)
      expect(where).toMatch(/"orderId" = \?/)
      expect(where).toMatch(/type = CAST/)
      expect(where).not.toMatch(/status/i)
    })

    it('🔴 I1 · cadena repartida entre los dos cobros: 1 pieza por el cobro 1 y 2 por el cobro 2 suman EXACTO lo cobrado ($10.00)', async () => {
      venta(
        [
          linea('A', { quantity: 3, unitPrice: new Decimal(4), total: new Decimal(12), discountAmount: new Decimal(2) }),
          linea('B', { unitPrice: new Decimal(10), total: new Decimal(10) }),
        ],
        2,
        [{ amount: 2, reparto: espejo({ A: 200 }) }],
      )
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(10)]).mockResolvedValueOnce([])
      await reembolsar([{ orderItemId: 'A', quantity: 1 }])
      devolucionesDeLaOrden = [{ id: 'refund-p1', processorData: filaReembolso(0).processorData }]
      prismaMock.$queryRaw.mockResolvedValueOnce([{ ...cobro(10), id: 'payment-2' }]).mockResolvedValueOnce([])
      await reembolsar([{ orderItemId: 'A', quantity: 2 }], { paymentId: 'payment-2' })

      const partes = [filaReembolso(0), filaReembolso(1)].map(f => f.processorData.refundedItems[0].amountCents)
      expect(partes).toEqual([334, 666])
      expect(partes[0] + partes[1]).toBe(1000)
    })

    it('🔴 M3 · una devolución BRUTA de antes de A (1 de 2 piezas a $50) + la otra ahora: nunca más que lo cobrado del renglón ($90 ⇒ $40)', async () => {
      venta([linea('A', { quantity: 2, unitPrice: new Decimal(50), discountAmount: new Decimal(10) }), linea('B')], 10, [
        { amount: 10, reparto: espejo({ A: 1000 }) },
      ])
      const previa = {
        id: 'refund-bruto',
        amount: -50,
        tipAmount: 0,
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        status: TransactionStatus.COMPLETED,
        processorData: { refundedItems: [{ orderItemId: 'A', quantity: 1, amountCents: 5000, amount: 50 }] },
      }
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(190)]).mockResolvedValueOnce([previa])

      const r = await reembolsar([{ orderItemId: 'A', quantity: 1 }])

      expect(r.amount).toBe(40)
      expect(filaReembolso().processorData.refundedItems[0]).toMatchObject({ amountCents: 4000, amount: 40 })
    })

    it('🔴 M1 · más renglones que el tope: el 400 dice la causa (no «descuentos») y no escribe nada', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(100)]).mockResolvedValueOnce([])
      venta(
        Array.from({ length: TOPES_POR_ORDEN.renglones + 1 }, (_, i) => linea(i === 0 ? 'A' : `r${i}`)),
        0,
      )

      await expect(reembolsar([{ orderItemId: 'A' }])).rejects.toThrow(
        'Esta venta tiene demasiados artículos, descuentos o devoluciones para devolverla por artículo; haz la devolución por importe.',
      )
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('🔴 M1 · más devoluciones en la orden que el tope: el mismo 400 por causa, sin escribir nada', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(100)]).mockResolvedValueOnce([])
      venta([linea('A'), linea('B')], 0)
      devolucionesDeLaOrden = Array.from({ length: TOPES_POR_ORDEN.movimientos + 1 }, (_, i) => ({ id: `r${i}`, processorData: {} }))

      await expect(reembolsar([{ orderItemId: 'A' }])).rejects.toThrow(
        'Esta venta tiene demasiados artículos, descuentos o devoluciones para devolverla por artículo; haz la devolución por importe.',
      )
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })

    it('🔴 el tope por cobro no cambia: con $100 ya devueltos de $140, devolver A (ahora $90) se sigue rechazando con el mismo 400', async () => {
      prismaMock.$queryRaw.mockResolvedValueOnce([cobro(140)]).mockResolvedValueOnce([
        {
          id: 'refund-previo',
          amount: -100,
          tipAmount: 0,
          createdAt: new Date('2026-10-09T10:00:00.000Z'),
          status: TransactionStatus.COMPLETED,
          processorData: {},
        },
      ])
      venta([linea('A', { discountAmount: new Decimal(10) }), linea('B', { unitPrice: new Decimal(50), total: new Decimal(50) })], 10, [
        { amount: 10, reparto: espejo({ A: 1000 }) },
      ])

      await expect(reembolsar([{ orderItemId: 'A' }])).rejects.toThrow('Refund (90.00) exceeds remaining refundable (40.00)')
      expect(prismaMock.payment.create).not.toHaveBeenCalled()
    })
  })
})

describe('issueRefund — replay MCP sin mover dinero de nuevo', () => {
  const input = {
    venueId: 'v',
    paymentId: 'original',
    amount: 1000,
    reason: 'OTHER' as const,
    staffId: 'staff',
    idempotencyKey: 'mcp-refund-0001',
  }
  beforeEach(() => jest.clearAllMocks())

  it('retorna el resultado durable antes de comprobar el saldo restante o iniciar efectos', async () => {
    const { operationHash } = await import('@/utils/operationHash')
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 'refund-existing',
      type: 'REFUND',
      amount: -10,
      tipAmount: 0,
      processorData: {
        originalPaymentId: 'original',
        idempotencyRequestHash: operationHash({ ...input, idempotencyKey: undefined }),
        remainingAfterCents: 0,
      },
    } as any)
    expect(await issueRefund(input)).toEqual({
      refundId: 'refund-existing',
      originalPaymentId: 'original',
      amount: 10,
      remainingRefundable: 0,
      status: 'COMPLETED',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('rechaza reutilizar una llave para otro monto, motivo o persona', async () => {
    prismaMock.payment.findUnique.mockResolvedValue({
      id: 'refund-existing',
      type: 'REFUND',
      amount: -10,
      tipAmount: 0,
      processorData: { originalPaymentId: 'original', idempotencyRequestHash: 'different', remainingAfterCents: 0 },
    } as any)
    await expect(issueRefund(input)).rejects.toThrow(/idempotencia/)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

// C2 · OF-2 (M2, `review-final.md`): `listRefundsForPayment` lo llama el detalle de cobro del POS en CADA apertura. Antes leía TODAS las
// devoluciones del negocio (sin tope, con `processorData` completo) y filtraba en JS por `originalPaymentId`. Ahora filtra en SQL por la
// ruta JSON, con orden y tope; el resultado es el mismo.
describe('C2 · OF-2 (M2) — listRefundsForPayment filtra en SQL y con tope', () => {
  const logger = jest.requireMock('@/config/logger').default
  const fila = (id: string, amount: number, tip: number, originalPaymentId = 'pay-1') => ({
    id,
    amount: new Decimal(amount),
    tipAmount: new Decimal(tip),
    status: 'COMPLETED',
    method: 'CASH',
    createdAt: new Date('2026-10-01T12:00:00Z'),
    processedBy: { firstName: 'Ana', lastName: 'R' },
    processorData: { originalPaymentId, refundReason: 'RETURNED_GOODS' },
  })
  beforeEach(() => {
    prismaMock.payment.findMany.mockReset()
    ;(logger.warn as jest.Mock).mockClear()
  })

  it('🔴 el `where` lleva venue, tipo y la ruta JSON `originalPaymentId`; con orden y `take`', async () => {
    prismaMock.payment.findMany.mockResolvedValue([] as any)
    await listRefundsForPayment('venue-1', 'pay-1')
    expect(prismaMock.payment.findMany).toHaveBeenCalledTimes(1)
    const args = prismaMock.payment.findMany.mock.calls[0][0] as any
    expect(args.where).toEqual({
      venueId: 'venue-1',
      type: PaymentType.REFUND,
      processorData: { path: ['originalPaymentId'], equals: 'pay-1' },
    })
    expect(args.orderBy).toEqual({ createdAt: 'desc' })
    expect(args.take).toBe(TOPE_DEVOLUCIONES_POR_COBRO)
  })

  it('control — el resultado es el de siempre: `amount` = total negativo (venta + propina) y el reparto aparte', async () => {
    prismaMock.payment.findMany.mockResolvedValue([fila('r2', -30, -5), fila('r1', -10, 0)] as any)
    const r = await listRefundsForPayment('venue-1', 'pay-1')
    expect(r).toEqual([
      expect.objectContaining({ id: 'r2', amount: -35, saleAmount: -30, tipAmount: -5, status: 'COMPLETED', method: 'CASH' }),
      expect.objectContaining({ id: 'r1', amount: -10, saleAmount: -10, tipAmount: 0 }),
    ])
    expect(r[0].processorData).toEqual({ originalPaymentId: 'pay-1', refundReason: 'RETURNED_GOODS' })
    expect(r[0].processedBy).toEqual({ firstName: 'Ana', lastName: 'R' })
  })

  it('🔴 si se llena el tope, lo avisa en el log (nunca en silencio)', async () => {
    prismaMock.payment.findMany.mockResolvedValue(
      Array.from({ length: TOPE_DEVOLUCIONES_POR_COBRO }, (_, i) => fila(`r${i}`, -1, 0)) as any,
    )
    const r = await listRefundsForPayment('venue-1', 'pay-1')
    expect(r).toHaveLength(TOPE_DEVOLUCIONES_POR_COBRO)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('tope'),
      expect.objectContaining({ venueId: 'venue-1', originalPaymentId: 'pay-1' }),
    )
  })
})
