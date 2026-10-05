import prisma from '@/utils/prismaClient'
import { removeIntentPromotions } from '@/services/promotions/promotion.service'

const prismaMock = prisma as any

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction = jest.fn((cb: any) => cb(prismaMock))
  // Candado canónico de la orden (Plan3b): la orden existe en este venue.
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'order-1' }])
  prismaMock.orderPromotion.findMany.mockResolvedValue([{ id: 'op-1' }, { id: 'op-2' }])
  prismaMock.orderPromotion.findFirst.mockResolvedValue({
    id: 'op-x',
    order: { paymentStatus: 'PENDING', discountAmount: 0, paidAmount: 0 },
  })
  prismaMock.orderItem.deleteMany.mockResolvedValue({ count: 2 })
  prismaMock.orderPromotion.delete.mockResolvedValue({})
  // recalculateOrderTotals dentro de la tx del retiro
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.orderDiscount.findMany.mockResolvedValue([])
  prismaMock.orderServiceCharge.findMany.mockResolvedValue([])
  prismaMock.order.update.mockResolvedValue({})
})

describe('removeIntentPromotions — compensación de una ronda rechazada, por instanceId', () => {
  it('🔴 descubre las promos del intent por instanceId, no sólo las creadas en esta llamada', async () => {
    // Audit 2026-08-14: el replay tras un RETRY regresa created:false (guarda de
    // idempotencia) — rastrear "las recién creadas" dejaba huérfanas las del
    // intento anterior del MISMO intent.
    const removed = await removeIntentPromotions('venue-1', 'order-1', ['inst-a', 'inst-b'])

    expect(prismaMock.orderPromotion.findMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1', instanceId: { in: ['inst-a', 'inst-b'] } },
      select: { id: true },
    })
    expect(removed).toBe(2)
    expect(prismaMock.orderItem.deleteMany).toHaveBeenCalledTimes(2)
  })

  it('sin instanceIds no consulta nada', async () => {
    const removed = await removeIntentPromotions('venue-1', 'order-1', [])

    expect(removed).toBe(0)
    expect(prismaMock.orderPromotion.findMany).not.toHaveBeenCalled()
  })

  it('un fallo al retirar UNA no detiene a las demás — best-effort que no tapa el error original', async () => {
    prismaMock.orderPromotion.findFirst
      .mockRejectedValueOnce(new Error('DB hiccup'))
      .mockResolvedValueOnce({ id: 'op-2', order: { paymentStatus: 'PENDING', discountAmount: 0, paidAmount: 0 } })

    const removed = await removeIntentPromotions('venue-1', 'order-1', ['inst-a', 'inst-b'])

    expect(removed).toBe(1)
    expect(prismaMock.orderItem.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('🔴 Codex r2 N5: un transitorio al compensar no se traga — termina las demás y lo relanza (el intent queda reintentable)', async () => {
    prismaMock.orderPromotion.findFirst
      .mockRejectedValueOnce(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))
      .mockResolvedValueOnce({ id: 'op-2', order: { paymentStatus: 'PENDING', discountAmount: 0, paidAmount: 0 } })
    await expect(removeIntentPromotions('venue-1', 'order-1', ['inst-a', 'inst-b'])).rejects.toMatchObject({ code: 'P2028' })
    expect(prismaMock.orderItem.deleteMany).toHaveBeenCalledTimes(1) // la segunda sí se compensó
  })

  it('🔴 N5: el transitorio se reconoce como lo clasifica el reducer (`errorCode ?? code`): un conflicto de versión también se relanza', async () => {
    prismaMock.orderPromotion.findFirst
      .mockResolvedValueOnce({ id: 'op-1', order: { paymentStatus: 'PENDING', discountAmount: 0, paidAmount: 0 } })
      .mockRejectedValueOnce(Object.assign(new Error('version'), { errorCode: 'VERSION_CONFLICT' }))
    await expect(removeIntentPromotions('venue-1', 'order-1', ['inst-a', 'inst-b'])).rejects.toMatchObject({
      errorCode: 'VERSION_CONFLICT',
    })
    expect(prismaMock.orderItem.deleteMany).toHaveBeenCalledTimes(1)
  })
})
