/** D5: `couponCode` en `/tpv/with-items`: el servidor calcula, liga la fila y no cuenta el uso al crear (sí en un carrito gratis). */
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ debeMarcarCocina: jest.fn().mockResolvedValue(false) }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/cuponDeLaVenta', () => ({
  ...jest.requireActual('@/services/shared/cuponDeLaVenta'),
  finalizeCouponsForOrder: jest.fn().mockResolvedValue(undefined),
}))

import { createOrderWithItems } from '@/services/tpv/order.tpv.service'
import { finalizeCouponsForOrder } from '@/services/shared/cuponDeLaVenta'

const descuento = (extra: Record<string, unknown> = {}) => ({
  id: 'd-1',
  venueId: 'v-1',
  name: 'Diez',
  active: true,
  type: 'PERCENTAGE',
  value: new Prisma.Decimal(10),
  scope: 'ORDER',
  maxDiscountAmount: null,
  minPurchaseAmount: null,
  compReason: null,
  ...extra,
})
const cupon = (d = descuento()) => ({
  id: 'cup-1',
  code: 'DESC10',
  active: true,
  maxUses: null,
  maxUsesPerCustomer: null,
  currentUses: 0,
  minPurchaseAmount: null,
  validFrom: null,
  validUntil: null,
  discount: d,
})

let creadas: any[]
const venta = (extra: Record<string, unknown> = {}) =>
  createOrderWithItems('v-1', {
    items: [{ productId: 'cafe', quantity: 1, unitPrice: 100 }],
    couponCode: 'desc10',
    discount: 10,
    staffId: 'staff-1',
    taxAmount: 0,
    subtotal: 100,
    total: 90,
    tip: 0,
    ...extra,
  } as any)

const conDescuento = (d: ReturnType<typeof descuento>) => {
  prismaMock.couponCode.findFirst.mockResolvedValue(cupon(d) as any)
  prismaMock.discount.findFirst.mockResolvedValue(d as any)
}

beforeEach(() => {
  jest.clearAllMocks()
  creadas = []
  ;(prismaMock as any).orderAction ??= { create: jest.fn() }
  const tx = {
    ...prismaMock,
    orderItem: {
      ...prismaMock.orderItem,
      create: jest.fn(async () => ({ id: 'oi-1' })),
      findMany: jest.fn(async () => [{ id: 'oi-1', total: 100, discountAmount: 0, orderPromotionId: null }]),
    },
    orderDiscount: {
      create: jest.fn(async ({ data }: any) => {
        const f = { id: `od-${creadas.length + 1}`, createdAt: new Date(0), appliedToItemIds: [], ...data }
        creadas.push(f)
        return f
      }),
      findMany: jest.fn(async () => creadas),
      update: jest.fn(async () => ({})),
    },
  }
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(tx))
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
  prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
  prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'sv-1', active: true, staff: { id: 'staff-1', active: true } } as any)
  prismaMock.product.findMany.mockResolvedValue([{ id: 'cafe', name: 'Café', price: 100, categoryId: 'c1', category: { name: 'B' } }] as any)
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.shift.findFirst.mockResolvedValue(null)
  conDescuento(descuento())
})

it('liga la fila al cupón con el nombre del ticket, y no cuenta el uso al crear', async () => {
  await venta()
  expect(creadas).toHaveLength(1)
  expect(creadas[0]).toMatchObject({ couponCodeId: 'cup-1', discountId: 'd-1', name: 'Diez (DESC10)', isManual: false })
  expect(Number(creadas[0].amount)).toBe(10)
  expect(prismaMock.discount.updateMany).not.toHaveBeenCalled()
  expect(finalizeCouponsForOrder).not.toHaveBeenCalled()
  expect((prismaMock.order.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
    discountAmount: new Prisma.Decimal(10),
    total: new Prisma.Decimal(90),
    paymentStatus: 'PENDING',
  })
})

it('al centavo: 10 % de $21.35 son $2.14, lo mismo que calculó la caja', async () => {
  prismaMock.product.findMany.mockResolvedValue([{ id: 'cafe', name: 'Café', price: 21.35, categoryId: 'c1', category: { name: 'B' } }] as any)
  await venta({ subtotal: 21.35, discount: 2.14, total: 19.21 })
  expect(Number(creadas[0].amount)).toBe(2.14)
})

it('el tope del catálogo viaja en el reparto para el siguiente recálculo', async () => {
  conDescuento(descuento({ value: new Prisma.Decimal(50), maxDiscountAmount: 20 }))
  await venta({ discount: 20, total: 80 })
  expect(Number(creadas[0].amount)).toBe(20)
  expect(creadas[0].reparto).toMatchObject({ alcance: 'CUENTA', tope: 20 })
})

it('carrito gratis: nace pagado y cuenta el uso tras el commit', async () => {
  conDescuento(descuento({ value: new Prisma.Decimal(100) }))
  prismaMock.payment.create.mockResolvedValue({ id: 'p-1' } as any)
  ;(prismaMock as any).paymentAllocation.create.mockResolvedValue({ id: 'pa-1' })
  await venta({ discount: 100, total: 0 })
  expect(finalizeCouponsForOrder).toHaveBeenCalledWith('v-1', 'order-1')
})

it('si el cupón cambió desde que se validó, lo dice y no crea la venta', async () => {
  conDescuento(descuento({ value: new Prisma.Decimal(20) }))
  await expect(venta()).rejects.toMatchObject({
    statusCode: 400,
    message: 'El cupón cambió de valor. Quítalo y vuelve a aplicarlo.',
  })
  expect(prismaMock.order.create).not.toHaveBeenCalled()
})

it('inválido: en español y sin crear nada', async () => {
  prismaMock.couponCode.findFirst.mockResolvedValue(null)
  await expect(venta()).rejects.toMatchObject({ statusCode: 400, message: 'No encontramos ese código de cupón.' })
  expect(prismaMock.order.create).not.toHaveBeenCalled()
})

it('cupón de cortesía sin autoridad: 403, como cualquier COMP', async () => {
  conDescuento(descuento({ type: 'COMP', value: new Prisma.Decimal(0) }))
  await expect(venta({ discount: 100, total: 0, canCompItems: false })).rejects.toMatchObject({ statusCode: 403 })
})

it('sin cupón no cambia nada: el descuento libre sigue siendo el de hoy', async () => {
  await venta({ couponCode: undefined })
  expect(creadas[0]).toMatchObject({ name: 'Descuento de la cuenta', isManual: true })
  expect(creadas[0].couponCodeId).toBeUndefined()
})
