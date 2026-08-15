/**
 * Venta rápida (carrito → cobrar) con promociones — camino ONLINE.
 *
 * El cliente que pidió las promociones hace autoservicio, o sea venta rápida:
 * la orden se crea por HTTP con `createOrderWithItems`, no por el reducer
 * offline. Sin esto, tocar un combo en el carrito y cobrar lo cobraba a precio
 * de lista (la línea caía como "Otro importe" de $0 y el combo salía gratis).
 *
 * El contrato de `promotionRef` es IDÉNTICO al del reducer (applyAddItems en
 * sync.mobile.service.ts): el cliente manda QUÉ promoción y QUÉ eligió la
 * persona — NUNCA precios. Toda la aritmética la hace el server.
 */

// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import * as promotionService from '@/services/promotions/promotion.service'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn(() => null),
  },
}))

/** Fila de Order tal como la devuelve Prisma con `createdOrderInclude`. */
function orderRow(items: any[], total: number) {
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
  }
}

const lineaProducto = {
  id: 'oi-1',
  productId: 'p1',
  productName: 'Hamburguesa',
  quantity: 1,
  unitPrice: new Decimal(100),
  total: new Decimal(100),
  discountAmount: new Decimal(0),
  appliedDiscountId: null,
  product: { id: 'p1', name: 'Hamburguesa', price: new Decimal(100) },
  modifiers: [],
}

// Lo que el motor de promociones deja en la orden: sus propias líneas, ya con
// el precio del combo repartido al centavo.
const lineaDeCombo = {
  id: 'oi-promo-1',
  productId: 'p9',
  productName: 'Refresco',
  quantity: 1,
  unitPrice: new Decimal(65),
  total: new Decimal(65),
  discountAmount: new Decimal(0),
  appliedDiscountId: null,
  product: { id: 'p9', name: 'Refresco', price: new Decimal(80) },
  modifiers: [],
}

describe('createOrderWithItems — líneas de promoción', () => {
  let apply: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: any) => callback(prismaMock))
    prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: 'venue-1' })
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p1', name: 'Hamburguesa', price: new Decimal(100), sku: 'BURG-1', category: { name: 'Comida' } },
    ])
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.order.create.mockResolvedValue(orderRow([lineaProducto], 100))
    // Relectura posterior a aplicar la promoción: el motor ya recalculó los
    // totales de la orden y agregó SUS líneas.
    prismaMock.order.findUnique.mockResolvedValue(orderRow([lineaProducto, lineaDeCombo], 165))

    apply = jest.spyOn(promotionService, 'applyPromotionToOrder').mockResolvedValue({
      orderPromotionId: 'op-1',
      netCents: 6500,
      created: true,
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('delega la promoción en applyPromotionToOrder y NO la da de alta como línea normal', async () => {
    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [
        { productId: 'p1', quantity: 1 },
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [{ groupId: 'g1', optionId: 'o1' }] } },
      ],
    } as any)

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        orderId: 'order-1',
        promotionId: 'promo-1',
        instanceId: 'uuid-1',
        selections: [{ groupId: 'g1', optionId: 'o1' }],
      }),
    )
    // La línea de promo NO pasa por el alta normal: su precio lo pone el motor.
    const createArgs = (prismaMock.order.create as jest.Mock).mock.calls[0][0]
    expect(createArgs.data.items.create).toHaveLength(1)
    expect(createArgs.data.items.create[0]).toEqual(expect.objectContaining({ productId: 'p1' }))
  })

  it('devuelve los totales YA recalculados por el motor, no los de la orden recién creada', async () => {
    // El POS pinta este total al cobrar: devolver el viejo (sin el combo) cobra
    // de menos, que es justo el bug que esta task cierra.
    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [
        { productId: 'p1', quantity: 1 },
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
      ],
    } as any)

    expect(prismaMock.order.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-1' } }))
    expect(result.total).toBe(165)
    expect(result.items).toHaveLength(2)
  })

  it('una orden de PURAS promociones se crea igual (sin items normales)', async () => {
    // buildOrderItemsData exige al menos un item; una venta que es sólo un combo
    // es legítima y no puede tronar con "At least one item is required".
    prismaMock.order.create.mockResolvedValue(orderRow([], 0))
    prismaMock.order.findUnique.mockResolvedValue(orderRow([lineaDeCombo], 65))

    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } }],
    } as any)

    expect(result.id).toBeDefined()
    expect(apply).toHaveBeenCalledTimes(1)
    const createArgs = (prismaMock.order.create as jest.Mock).mock.calls[0][0]
    expect(createArgs.data.items.create).toHaveLength(0)
  })

  it('es idempotente: el mismo promotionInstanceId no cobra el combo dos veces', async () => {
    // applyPromotionToOrder ya deduplica por (orderId, instanceId) devolviendo
    // created:false. Aquí se verifica que createOrderWithItems no lo llame dos
    // veces por el mismo instanceId dentro de la misma orden (doble tap del cajero).
    apply.mockResolvedValue({ orderPromotionId: 'op-1', netCents: 6500, created: false })

    await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
        { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
      ],
    } as any)

    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('compensa las promociones ya aplicadas si una posterior truena (nada de combos a medias)', async () => {
    // Espejo de applyAddItems: la promo #1 ya commiteó en su propia tx. Si la #2
    // falla, la orden se queda con MEDIO combo aplicado y el POS reintenta con
    // el mismo externalId, que devuelve esa orden a medias. Se retiran.
    const remove = jest.spyOn(promotionService, 'removeIntentPromotions').mockResolvedValue(1)
    apply
      .mockResolvedValueOnce({ orderPromotionId: 'op-1', netCents: 6500, created: true })
      .mockRejectedValueOnce(new Error('Esa promoción no está publicada.'))

    await expect(
      createOrderWithItems('venue-1', {
        staffId: 'staff-1',
        items: [
          { promotionRef: { promotionId: 'promo-1', promotionInstanceId: 'uuid-1', selections: [] } },
          { promotionRef: { promotionId: 'promo-2', promotionInstanceId: 'uuid-2', selections: [] } },
        ],
      } as any),
    ).rejects.toThrow('Esa promoción no está publicada.')

    expect(remove).toHaveBeenCalledWith('venue-1', 'order-1', ['uuid-1', 'uuid-2'])
  })

  // ── REGRESIÓN: la venta rápida de siempre no cambia en nada ──

  it('una orden SIN promotionRef no toca el motor de promociones ni relee la orden', async () => {
    const result = await createOrderWithItems('venue-1', {
      staffId: 'staff-1',
      items: [{ productId: 'p1', quantity: 1 }],
    } as any)

    expect(apply).not.toHaveBeenCalled()
    expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
    expect(result.total).toBe(100)
  })

  it('una orden sin artículos NI promociones se rechaza en español', async () => {
    await expect(createOrderWithItems('venue-1', { staffId: 'staff-1', items: [] } as any)).rejects.toThrow(
      'Se requiere al menos un artículo o una promoción',
    )
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })
})
