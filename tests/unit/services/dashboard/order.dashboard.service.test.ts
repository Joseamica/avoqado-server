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
