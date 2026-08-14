import { PaymentType } from '@prisma/client'
import { mapOrderPaymentsWithRefunds } from '@/services/dashboard/order.dashboard.service'

describe('order.dashboard.service — mapOrderPaymentsWithRefunds', () => {
  it('hoists originalPaymentId and refundReason from processorData on REFUND payments', () => {
    const payments = [
      { id: 'p-original', type: PaymentType.REGULAR, amount: 100, processorData: {} },
      {
        id: 'p-refund',
        type: PaymentType.REFUND,
        amount: -25,
        processorData: { originalPaymentId: 'p-original', refundReason: 'Producto defectuoso', amount: 25 },
      },
    ] as any[]

    const result = mapOrderPaymentsWithRefunds(payments)
    const refund = result.find(p => p.id === 'p-refund')!

    expect(refund.originalPaymentId).toBe('p-original')
    expect(refund.refundReason).toBe('Producto defectuoso')
  })

  it('attaches a refunds[] array to the original payment', () => {
    const payments = [
      { id: 'p-original', type: PaymentType.REGULAR, amount: 100, processorData: {} },
      {
        id: 'p-refund',
        type: PaymentType.REFUND,
        amount: -25,
        createdAt: new Date('2026-04-17T11:35:00Z'),
        processorData: { originalPaymentId: 'p-original', refundReason: 'Cliente insatisfecho' },
      },
    ] as any[]

    const result = mapOrderPaymentsWithRefunds(payments)
    const original = result.find(p => p.id === 'p-original')!

    expect(original.refunds).toHaveLength(1)
    expect(original.refunds[0]).toMatchObject({
      id: 'p-refund',
      amount: -25,
      refundReason: 'Cliente insatisfecho',
    })
  })

  it('handles orphan refund (no matching original payment) without throwing', () => {
    const payments = [
      {
        id: 'p-orphan-refund',
        type: PaymentType.REFUND,
        amount: -10,
        processorData: { originalPaymentId: 'p-missing', refundReason: 'x' },
      },
    ] as any[]

    expect(() => mapOrderPaymentsWithRefunds(payments)).not.toThrow()
    const refund = mapOrderPaymentsWithRefunds(payments)[0]
    expect(refund.originalPaymentId).toBe('p-missing')
  })

  it('does not mutate non-refund payments beyond adding empty refunds[]', () => {
    const payments = [{ id: 'p1', type: PaymentType.REGULAR, amount: 50, processorData: {} }] as any[]
    const result = mapOrderPaymentsWithRefunds(payments)
    expect(result[0].refunds).toEqual([])
    expect(result[0].id).toBe('p1')
  })

  it('handles missing or null processorData on a refund (defensive default)', () => {
    const payments = [{ id: 'p-refund', type: PaymentType.REFUND, amount: -5, processorData: null }] as any[]
    const result = mapOrderPaymentsWithRefunds(payments)
    expect(result[0].originalPaymentId).toBeNull()
    expect(result[0].refundReason).toBeNull()
  })

  it('aggregates multiple partial refunds against the same original payment', () => {
    const payments = [
      {
        id: 'p-original',
        type: PaymentType.REGULAR,
        amount: 100,
        createdAt: new Date('2026-04-17T11:00:00Z'),
        processorData: {},
      },
      {
        id: 'r1',
        type: PaymentType.REFUND,
        amount: -30,
        createdAt: new Date('2026-04-17T11:30:00Z'),
        processorData: { originalPaymentId: 'p-original', refundReason: 'Item dañado' },
      },
      {
        id: 'r2',
        type: PaymentType.REFUND,
        amount: -20,
        createdAt: new Date('2026-04-17T12:00:00Z'),
        processorData: { originalPaymentId: 'p-original', refundReason: 'Cliente cambió de opinión' },
      },
    ] as any[]

    const result = mapOrderPaymentsWithRefunds(payments)
    const original = result.find(p => p.id === 'p-original')!

    expect(original.refunds).toHaveLength(2)
    expect(original.refunds.map((r: { id: string }) => r.id)).toEqual(['r1', 'r2'])
    expect(original.refunds.reduce((s: number, r: { amount: number }) => s + Number(r.amount), 0)).toBe(-50)
  })

  it('does NOT attach a refund to another refund (cascading-refund guard)', () => {
    const payments = [
      { id: 'p-original', type: PaymentType.REGULAR, amount: 100, createdAt: new Date(), processorData: {} },
      {
        id: 'r1',
        type: PaymentType.REFUND,
        amount: -50,
        createdAt: new Date(),
        processorData: { originalPaymentId: 'p-original' },
      },
      {
        // Bogus: a refund pointing at another refund. Should NOT be attached.
        id: 'r2-of-r1',
        type: PaymentType.REFUND,
        amount: -10,
        createdAt: new Date(),
        processorData: { originalPaymentId: 'r1' },
      },
    ] as any[]

    const result = mapOrderPaymentsWithRefunds(payments)
    const r1 = result.find(p => p.id === 'r1')!
    expect(r1.refunds).toHaveLength(0)
  })
})

// ── deleteOrder: guard contra borrar órdenes con dinero (auditoría 2026-08-12) ──
// El DELETE del dashboard cancelaba CUALQUIER orden sin mirar paymentStatus: una
// orden PAGADA (dinero cobrado + stock deducido) quedaba CANCELLED — invisible
// para reportes, sin reembolso y sin reposición. El guard exige reembolsar primero.
import { deleteOrder } from '@/services/dashboard/order.dashboard.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

describe('order.dashboard.service — deleteOrder guard de pagos', () => {
  beforeEach(() => jest.clearAllMocks())

  const arrange = (order: Record<string, unknown>, completedPayments = 0) => {
    prismaMock.order.findFirst.mockResolvedValue(order as any)
    prismaMock.payment.count.mockResolvedValue(completedPayments as any)
    prismaMock.order.update.mockResolvedValue({ id: 'order-1', venueId: 'venue-1', status: 'CANCELLED' } as any)
  }

  it('rechaza cancelar una orden PAID', async () => {
    arrange({ id: 'order-1', paymentStatus: 'PAID' })

    await expect(deleteOrder('venue-1', 'order-1')).rejects.toThrow(/pago|reembols/i)
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('rechaza cancelar una orden PARTIAL (ya tiene dinero adentro)', async () => {
    arrange({ id: 'order-1', paymentStatus: 'PARTIAL' })

    await expect(deleteOrder('venue-1', 'order-1')).rejects.toThrow(/pago|reembols/i)
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('rechaza si hay Payments COMPLETED aunque el paymentStatus diga PENDING (estado inconsistente)', async () => {
    arrange({ id: 'order-1', paymentStatus: 'PENDING' }, 1)

    await expect(deleteOrder('venue-1', 'order-1')).rejects.toThrow(/pago|reembols/i)
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('sigue cancelando una orden PENDING sin pagos (regresión)', async () => {
    arrange({ id: 'order-1', paymentStatus: 'PENDING' }, 0)

    const res = await deleteOrder('venue-1', 'order-1')

    expect(res.status).toBe('CANCELLED')
    expect(prismaMock.order.update).toHaveBeenCalled()
  })
})

// ── settleOrder: CAS atómico — dos settles concurrentes = UN solo pago ──
// (auditoría 2026-08-12, hallazgo 7 de Codex: el guard leía fuera de la
// transacción y el update era ciego; dos settles simultáneos creaban dos
// Payments CASH por el mismo saldo.)
import { settleOrder } from '@/services/dashboard/order.dashboard.service'

describe('order.dashboard.service — settleOrder atómico', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  })

  const ORDER = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    total: 100,
    remainingBalance: 100,
    paymentStatus: 'PENDING',
  }

  it('liquida con CAS: transición condicional + UN pago por el restante', async () => {
    prismaMock.order.findFirst.mockResolvedValue(ORDER as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.payment.create.mockResolvedValue({ id: 'pay-1' } as any)

    const res = await settleOrder('venue-1', 'order-1')

    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1', venueId: 'venue-1', paymentStatus: { in: ['PENDING', 'PARTIAL'] } }),
      }),
    )
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
    expect(res.settledAmount).toBe(100)
  })

  it('el settle que PIERDE la carrera no crea un segundo pago', async () => {
    prismaMock.order.findFirst.mockResolvedValue(ORDER as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 } as any)

    const res = await settleOrder('venue-1', 'order-1')

    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(res.settledAmount).toBe(0)
  })

  it('orden ya PAID no crea pago (regresión)', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ ...ORDER, paymentStatus: 'PAID', remainingBalance: 0 } as any)

    const res = await settleOrder('venue-1', 'order-1')

    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(res.settledAmount).toBe(0)
  })

  // 🔴 Auditoría 2026-08-13: el CAS de estados protegía la transición pero el
  // MONTO venía del snapshot pre-tx. Un pago parcial concurrente ($60 en la
  // TPV) dejaba la orden PARTIAL con $40 restantes; el settle seguía pasando
  // (PARTIAL está permitido) y creaba un Payment por los $100 VIEJOS: $160 de
  // pagos contra una orden de $100.
  it('el monto sale de la RELECTURA dentro de la tx, no del snapshot viejo', async () => {
    prismaMock.order.findFirst
      .mockResolvedValueOnce(ORDER as any) // snapshot pre-tx: $100 restantes
      .mockResolvedValueOnce({ ...ORDER, paymentStatus: 'PARTIAL', remainingBalance: 40, version: 7 } as any) // dentro de la tx: ya entró un parcial de $60
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.payment.create.mockResolvedValue({ id: 'pay-1' } as any)

    const res = await settleOrder('venue-1', 'order-1')

    // El Payment y la respuesta reflejan los $40 REALES, nunca los $100 viejos.
    expect(prismaMock.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 40, netAmount: 40 }) }),
    )
    expect(res.settledAmount).toBe(40)
    // Y la transición va amarrada a la versión releída: si algo cambia después
    // de la relectura, el CAS pierde y no se cobra nada.
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 7 }) }))
  })

  it('si la orden cambia ENTRE la relectura y el CAS (version pisada), no se crea pago', async () => {
    prismaMock.order.findFirst.mockResolvedValueOnce(ORDER as any).mockResolvedValueOnce({ ...ORDER, version: 3 } as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 } as any) // la versión ya no coincide

    const res = await settleOrder('venue-1', 'order-1')

    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(res.settledAmount).toBe(0)
  })
})
