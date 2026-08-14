import prisma from '@/utils/prismaClient'
import { removePromotionFromOrder } from '@/services/promotions/promotion.service'

const prismaMock = prisma as any

const params = () => ({ venueId: 'venue-1', orderId: 'order-1', orderPromotionId: 'op-1' })

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock))
  prismaMock.orderPromotion.findFirst.mockResolvedValue({
    id: 'op-1',
    order: { paymentStatus: 'PENDING', discountAmount: 0, paidAmount: 0 },
  })
  prismaMock.orderItem.deleteMany.mockResolvedValue({ count: 3 })
  prismaMock.orderPromotion.delete.mockResolvedValue({})
  // Lo que el recálculo de totales lee dentro de la tx.
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.orderDiscount.findMany.mockResolvedValue([])
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  prismaMock.order.update.mockResolvedValue({})
})

describe('removePromotionFromOrder', () => {
  it('🔴 borra TODAS las líneas de la promoción, no una', async () => {
    await removePromotionFromOrder(params())

    expect(prismaMock.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderPromotionId: 'op-1' } })
    expect(prismaMock.orderPromotion.delete).toHaveBeenCalledWith({ where: { id: 'op-1' } })
  })

  it('todo va dentro de UNA transacción', async () => {
    await removePromotionFromOrder(params())

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('🔴 retirar recalcula los totales de la orden en la MISMA transacción', async () => {
    // Audit 2026-08-13: quitar un combo de $99 dejaba Order.total en $199.
    await removePromotionFromOrder(params())

    expect(prismaMock.order.update).toHaveBeenCalled()
    expect(prismaMock.order.update.mock.calls[0][0].data).toHaveProperty('total')
  })

  it('🔴 de una cuenta PAGADA no se retira: eso es un reembolso', async () => {
    prismaMock.orderPromotion.findFirst.mockResolvedValue({
      id: 'op-1',
      order: { paymentStatus: 'PAID', discountAmount: 0, paidAmount: 199 },
    })

    await expect(removePromotionFromOrder(params())).rejects.toThrow(/reembolso/i)
    expect(prismaMock.orderItem.deleteMany).not.toHaveBeenCalled()
  })

  it('🔴 la promoción de otro venue no se puede retirar', async () => {
    prismaMock.orderPromotion.findFirst.mockResolvedValue(null)

    await expect(removePromotionFromOrder({ ...params(), venueId: 'venue-ajeno' })).rejects.toThrow(/no encontr/i)
    expect(prismaMock.orderItem.deleteMany).not.toHaveBeenCalled()
  })
})
