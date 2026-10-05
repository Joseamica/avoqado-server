/**
 * IVA por producto, B2 (spec §4.1, D7; P2): «Cobrar» guarda el reparto de sus filas y el descuento libre nuevo tiene su fila.
 * El cobro es el de hoy.
 */
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

import { createOrderWithItems } from '@/services/tpv/order.tpv.service'

const catalogo = (id: string, extra: Record<string, unknown>) => ({
  id,
  venueId: 'venue-1',
  name: id,
  active: true,
  validFrom: null,
  validUntil: null,
  maxTotalUses: null,
  currentUses: 0,
  minPurchaseAmount: null,
  maxDiscountAmount: null,
  compReason: null,
  ...extra,
})
let tx: any
let creadas: any[]

function armarTx(renglones: unknown[]) {
  creadas = []
  let n = 0
  ;(prismaMock as any).orderAction ??= { create: jest.fn() }
  ;(prismaMock as any).orderAction.create.mockResolvedValue({ id: 'a' })
  tx = {
    ...prismaMock,
    orderItem: { ...prismaMock.orderItem, create: jest.fn(async () => ({ id: `oi-${++n}` })), findMany: jest.fn(async () => renglones) },
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
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
  prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
  prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'sv-1', active: true, staff: { id: 'staff-1', active: true } } as any)
  // El doble filtra por `id in` como la base: el servicio exige tantos productos como pidió.
  const productos = [
    { id: 'cafe', name: 'Café', price: 100, categoryId: 'c1', category: { name: 'Bebidas' } },
    { id: 'pan', name: 'Pan', price: 50, categoryId: 'c1', category: { name: 'Pan' } },
    { id: 'jugo', name: 'Jugo', price: 50, categoryId: 'c1', category: { name: 'Bebidas' } },
  ]
  prismaMock.product.findMany.mockImplementation((async ({ where }: any) => productos.filter(p => where.id.in.includes(p.id))) as any)
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([
    catalogo('art10', { type: 'PERCENTAGE', value: new Prisma.Decimal(10), scope: 'ITEM', targetItemIds: [] }),
    catalogo('orden20', { type: 'FIXED_AMOUNT', value: new Prisma.Decimal(20), scope: 'ORDER' }),
  ] as any)
  prismaMock.discount.updateMany.mockResolvedValue({ count: 2 } as any)
  prismaMock.shift.findFirst.mockResolvedValue(null)
})

it('cortesía (espejo), artículo (espejo) y orden (CUENTA con base): repartos exactos; el cobro es el de hoy', async () => {
  armarTx([
    { id: 'oi-1', total: 100, discountAmount: 10, orderPromotionId: null },
    { id: 'oi-2', total: 50, discountAmount: 50, orderPromotionId: null },
    { id: 'oi-3', total: 50, discountAmount: 0, orderPromotionId: null },
  ])
  await createOrderWithItems('venue-1', {
    items: [
      { productId: 'cafe', quantity: 1, unitPrice: 100, itemDiscountId: 'art10' },
      { productId: 'pan', quantity: 1, unitPrice: 50, isCortesia: true, cortesiaReason: 'Invitación' },
      { productId: 'jugo', quantity: 1, unitPrice: 50 },
    ],
    orderDiscountId: 'orden20',
    discount: 20,
    staffId: 'staff-1',
    taxAmount: 0,
    subtotal: 200,
    total: 120,
    tip: 0,
  } as any)
  const [comp, articulo, orden] = creadas
  expect(comp.reparto).toEqual({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-2': 5000 } })
  expect(articulo.reparto).toEqual({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { 'oi-1': 1000 } })
  expect(orden.reparto).toEqual({ v: 1, alcance: 'CUENTA', conPromociones: false, base: ['oi-1', 'oi-3'], espejo: false, renglones: {} })
  // 2 000 centavos sobre lo que aportan café (9 000) y jugo (5 000): 1 286 y 714.
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({
    where: { id: 'od-3' },
    data: { reparto: { ...orden.reparto, renglones: { 'oi-1': 1286, 'oi-3': 714 } } },
  })
  expect(prismaMock.orderDiscount.update).not.toHaveBeenCalled()
  expect((prismaMock.order.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
    subtotal: new Prisma.Decimal(200),
    discountAmount: new Prisma.Decimal(80),
    total: new Prisma.Decimal(120),
  })
})

it('🔴 P2 antes/después: el descuento libre de la terminal (sin orderDiscountId) tiene su fila de cuenta; hoy sólo vivía en la cabecera', async () => {
  armarTx([
    { id: 'oi-1', total: 100, discountAmount: 0, orderPromotionId: null },
    { id: 'oi-2', total: 50, discountAmount: 0, orderPromotionId: null },
  ])
  await createOrderWithItems('venue-1', {
    items: [
      { productId: 'cafe', quantity: 1, unitPrice: 100 },
      { productId: 'jugo', quantity: 1, unitPrice: 50 },
    ],
    discount: 15,
    staffId: 'staff-1',
    taxAmount: 0,
    subtotal: 150,
    total: 135,
    tip: 0,
  } as any)
  expect(creadas).toHaveLength(1)
  expect(creadas[0]).toMatchObject({
    type: 'FIXED_AMOUNT',
    name: 'Descuento de la cuenta',
    amount: new Prisma.Decimal(15),
    isManual: true,
    appliedById: 'sv-1',
  })
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({
    where: { id: 'od-1' },
    data: { reparto: expect.objectContaining({ alcance: 'CUENTA', renglones: { 'oi-1': 1000, 'oi-2': 500 } }) },
  })
  expect((prismaMock.order.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
    discountAmount: new Prisma.Decimal(15),
    total: new Prisma.Decimal(135),
  })
})

it('control de regresión: una venta de «Cobrar» sin descuentos ni cortesías no crea filas ni sincroniza; el cobro es el de hoy', async () => {
  armarTx([{ id: 'oi-1', total: 100, discountAmount: 0, orderPromotionId: null }])
  await createOrderWithItems('venue-1', {
    items: [{ productId: 'cafe', quantity: 1, unitPrice: 100 }],
    staffId: 'staff-1',
    taxAmount: 0,
    subtotal: 100,
    total: 100,
    tip: 0,
  } as any)
  expect(creadas).toHaveLength(0)
  expect(tx.orderDiscount.findMany).not.toHaveBeenCalled()
  expect((prismaMock.order.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
    discountAmount: new Prisma.Decimal(0),
    total: new Prisma.Decimal(100),
  })
})
