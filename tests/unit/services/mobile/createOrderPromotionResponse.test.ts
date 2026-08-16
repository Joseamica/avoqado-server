/**
 * La respuesta de crear orden manda las líneas de un combo SUELTAS, sin nada
 * que las ate — el POS no puede agruparlas en el carrito ni escribir "Combo
 * del día" en el recibo. `OrderItem.orderPromotionId` y `OrderPromotion` (con
 * su snapshot) ya existen en la DB; esta suite prueba que la respuesta de
 * `createOrderWithItems` por fin los expone.
 *
 * El NOMBRE de la promoción sale del SNAPSHOT (lo que se cobró), nunca de la
 * promoción viva: un ticket histórico no cambia porque alguien edite el
 * combo después. `netCents`/`discountCents` se exponen tal cual — son
 * centavos internos del contrato, no pesos.
 */

// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta
// suite: se prueba en tests/unit/services/venueSalesGuard.test.ts.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn(() => null),
  },
}))

import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

/** Fila de Order tal como la devuelve Prisma con `createdOrderInclude`. */
function orderRow(items: any[], promotions: any[] = []) {
  const total = items.reduce((sum, item) => sum + Number(item.total), 0)
  return {
    id: 'order-1',
    orderNumber: 'ORD-1',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: new Decimal(total),
    discountAmount: new Decimal(0),
    taxAmount: new Decimal(0),
    total: new Decimal(total),
    createdAt: new Date('2026-08-15T10:00:00.000Z'),
    items,
    promotions,
  }
}

/** Línea de `OrderItem` — `orderPromotionId` es un escalar más, ya viene del include. */
function lineItem(id: string, orderPromotionId: string | null, overrides: Record<string, any> = {}) {
  return {
    id,
    productId: 'p1',
    productName: 'Producto suelto',
    quantity: 1,
    unitPrice: new Decimal(30),
    total: new Decimal(30),
    discountAmount: new Decimal(0),
    appliedDiscountId: null,
    orderPromotionId,
    product: { id: 'p1', name: 'Producto suelto', price: new Decimal(30) },
    modifiers: [],
    ...overrides,
  }
}

describe('createOrderWithItems — la respuesta permite agrupar las líneas de un combo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 's1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Producto suelto', price: new Decimal(30), sku: 'SKU-1', category: { name: 'General' } },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
  })

  it('devuelve orderPromotionId en cada línea nacida de una promoción', async () => {
    const items = [
      lineItem('oi-1', 'op-1', { productId: 'p9', productName: 'Refresco', unitPrice: new Decimal(49.5), total: new Decimal(49.5) }),
      lineItem('oi-2', 'op-1', { productId: 'p9', productName: 'Refresco', unitPrice: new Decimal(49.5), total: new Decimal(49.5) }),
      lineItem('oi-3', null),
    ]
    prismaMock.order.create.mockResolvedValue(orderRow(items))

    const res = await createOrderWithItems('venue-1', { staffId: 's1', items: [{ productId: 'p1', quantity: 1 }] } as any)

    expect(res.items.filter(i => i.orderPromotionId === 'op-1')).toHaveLength(2)
    expect(res.items.find(i => i.orderPromotionId === null)).toBeDefined()
  })

  it('devuelve el nombre y el neto de cada promoción vendida, tomados del snapshot', async () => {
    const items = [
      lineItem('oi-1', 'op-1', { productId: 'p9', productName: 'Refresco', unitPrice: new Decimal(49.5), total: new Decimal(49.5) }),
      lineItem('oi-2', 'op-1', { productId: 'p9', productName: 'Refresco', unitPrice: new Decimal(49.5), total: new Decimal(49.5) }),
    ]
    const promotions = [
      {
        id: 'op-1',
        instanceId: 'uuid-1',
        // El snapshot es lo que se COBRÓ — si alguien edita la promo después,
        // el ticket histórico no cambia.
        snapshotJson: { name: 'Combo del día', type: 'COMBO', pricingMode: 'FIXED', priceCents: 9900, selections: [] },
        netCents: 9900,
        discountCents: 0,
        needsReview: false,
      },
    ]
    prismaMock.order.create.mockResolvedValue(orderRow(items, promotions))

    const res = await createOrderWithItems('venue-1', { staffId: 's1', items: [{ productId: 'p1', quantity: 1 }] } as any)

    expect(res.promotions).toEqual([
      expect.objectContaining({ id: 'op-1', instanceId: 'uuid-1', name: 'Combo del día', netCents: 9900, needsReview: false }),
    ])
  })

  it('una orden sin promociones trae promotions: [] y todas las líneas con orderPromotionId null', async () => {
    prismaMock.order.create.mockResolvedValue(orderRow([lineItem('oi-1', null)]))

    const res = await createOrderWithItems('venue-1', { staffId: 's1', items: [{ productId: 'p1', quantity: 1 }] } as any)

    expect(res.promotions).toEqual([])
    expect(res.items.every(i => i.orderPromotionId === null)).toBe(true)
  })
})
