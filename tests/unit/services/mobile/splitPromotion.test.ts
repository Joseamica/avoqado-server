import prisma from '@/utils/prismaClient'
import { splitOrderItems } from '@/services/mobile/order.mobile.service'

const prismaMock = prisma as any

const fuente = (items: Array<{ id: string; orderPromotionId?: string | null }>) => ({
  id: 'order-1',
  orderNumber: 'ORD-1',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  tableId: 't1',
  covers: 2,
  servedById: 'staff-1',
  type: 'DINE_IN',
  paidAmount: 0,
  items: items.map(i => ({ id: i.id, orderPromotionId: i.orderPromotionId ?? null })),
  orderDiscounts: [],
  serviceCharges: [],
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock))
  prismaMock.order.create.mockResolvedValue({ id: 'order-2', orderNumber: 'ORD-2', version: 1 })
  prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.orderPromotion.updateMany.mockResolvedValue({ count: 1 })
  // recalculateOrderTotals dentro de la tx
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.orderDiscount.findMany.mockResolvedValue([])
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  prismaMock.order.update.mockResolvedValue({ total: 0, version: 2 })
})

describe('splitOrderItems — una promoción se mueve completa o no se mueve', () => {
  it('🔴 mover UN componente de un combo a otro cheque se rechaza', async () => {
    // Audit 2026-08-13 (Codex): partir el combo dejaba OrderPromotion.orderId en
    // el origen y cada cheque veía un subconjunto "completo" reembolsable.
    prismaMock.order.findFirst.mockResolvedValue(
      fuente([{ id: 'i1', orderPromotionId: 'op-1' }, { id: 'i2', orderPromotionId: 'op-1' }, { id: 'n1' }]),
    )

    await expect(splitOrderItems('venue-1', 'order-1', ['i1'])).rejects.toThrow(/completa/i)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('mover el combo COMPLETO se permite y la instancia lo sigue al cheque nuevo', async () => {
    prismaMock.order.findFirst.mockResolvedValue(
      fuente([{ id: 'i1', orderPromotionId: 'op-1' }, { id: 'i2', orderPromotionId: 'op-1' }, { id: 'n1' }]),
    )

    await splitOrderItems('venue-1', 'order-1', ['i1', 'i2'])

    expect(prismaMock.orderPromotion.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['op-1'] }, orderId: 'order-1' },
      data: { orderId: 'order-2' },
    })
  })

  it('mover sólo líneas normales no toca OrderPromotion (regresión)', async () => {
    prismaMock.order.findFirst.mockResolvedValue(
      fuente([{ id: 'i1', orderPromotionId: 'op-1' }, { id: 'i2', orderPromotionId: 'op-1' }, { id: 'n1' }, { id: 'n2' }]),
    )

    await splitOrderItems('venue-1', 'order-1', ['n1'])

    expect(prismaMock.orderPromotion.updateMany).not.toHaveBeenCalled()
  })
})
