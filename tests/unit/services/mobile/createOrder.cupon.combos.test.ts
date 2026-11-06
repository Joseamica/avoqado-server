/**
 * D5, Codex r1 #6: una venta de puros combos que sí cumple la compra mínima del cupón no se rechaza. Los combos se arman después de las
 * líneas normales, así que el mínimo se revisa contra la base CON promociones. Mismo arnés que `createOrderPromotion.test.ts`.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import * as promotionService from '@/services/promotions/promotion.service'
import { prismaMock } from '../../../__helpers__/setup'

const orden = (total: number) => ({
  id: 'order-1',
  orderNumber: 'ORD-1',
  status: 'CONFIRMED',
  paymentStatus: 'PENDING',
  subtotal: new Decimal(total),
  discountAmount: new Decimal(0),
  taxAmount: new Decimal(0),
  total: new Decimal(total),
  createdAt: new Date('2026-11-05T10:00:00.000Z'),
  items: [],
})

const descuento = {
  id: 'd-1',
  venueId: 'venue-1',
  name: 'Diez',
  active: true,
  type: 'PERCENTAGE',
  value: new Decimal(10),
  scope: 'ORDER',
  maxDiscountAmount: null,
  minPurchaseAmount: null,
  compReason: null,
}
const cupon = {
  id: 'cup-1',
  code: 'DESC10',
  active: true,
  maxUses: null,
  maxUsesPerCustomer: null,
  currentUses: 0,
  minPurchaseAmount: new Decimal(150),
  validFrom: null,
  validUntil: null,
  discount: descuento,
}

const comboDe = (pesos: number) => {
  prismaMock.order.findFirst.mockResolvedValue({ subtotal: new Decimal(pesos), serviceChargeAmount: new Decimal(0), paidAmount: new Decimal(0) })
}
const venta = () =>
  createOrderWithItems('venue-1', {
    staffId: 'staff-1',
    items: [{ promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } }],
    couponCode: 'DESC10',
  } as any)

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true } as any)
  prismaMock.product.findMany.mockResolvedValue([])
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.order.create.mockResolvedValue(orden(0) as any)
  prismaMock.order.update.mockResolvedValue(orden(180) as any)
  prismaMock.couponCode.findFirst.mockResolvedValue(cupon as any)
  prismaMock.discount.findFirst.mockResolvedValue(descuento as any)
  jest.spyOn(promotionService, 'applyPromotionToOrder').mockResolvedValue({ orderPromotionId: 'op-1', netCents: 20000, created: true })
})

afterEach(() => jest.restoreAllMocks())

it('un combo de $200 cumple el mínimo de $150: el cupón rebaja $20 y la fila queda ligada', async () => {
  comboDe(200)
  await venta()
  expect(prismaMock.order.update).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ discountAmount: new Decimal(20), total: new Decimal(180) }) }),
  )
  expect((prismaMock.orderDiscount.create as jest.Mock).mock.calls[0][0].data).toMatchObject({ couponCodeId: 'cup-1', name: 'Diez (DESC10)' })
})

it('un combo de $100 no cumple el mínimo: se rechaza con su razón', async () => {
  comboDe(100)
  await expect(venta()).rejects.toMatchObject({ statusCode: 400, message: 'Este cupón pide una compra mínima de $150.00.' })
})
