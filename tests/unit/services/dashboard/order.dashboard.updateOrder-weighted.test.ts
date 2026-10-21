/**
 * updateOrder (dashboard) — este camino YA NO deduce inventario.
 *
 * HISTORIA (importante para no reintroducirlo):
 * La fase 3 del plan de inventario arregló aquí un bug real: al completar una
 * orden desde el dashboard, la deducción pasaba `item.quantity` (siempre 1 en
 * líneas pesadas) en vez de `item.weightQuantity` (los kilos), así que vender
 * 435 g descontaba 1 kilo. Ese fix fue correcto para el bug que atacaba.
 *
 * La fase 3.5 (audit Codex gpt-5.6-sol xhigh, 2026-08-14) fue más al fondo:
 * `updateOrder` NO debería deducir en absoluto. Dos razones:
 *
 *   1. `Order.status` es estado OPERATIVO, no evidencia de pago. Deducir al
 *      pasar a COMPLETED contradice la regla del repo — "el stock se descuenta
 *      sólo cuando la orden queda pagada" (.claude/rules/payments.md).
 *   2. Lo hacía SIN posting: movimientos con `postingLineId: null` que el UNIQUE
 *      del vale durable no puede ver. Una orden marcada COMPLETED a mano y luego
 *      liquidada con `settleOrder` se deducía DOS VECES.
 *
 * Por eso este archivo pasó de "deduce los kilos correctos" a "no deduce".
 * La corrección de peso sigue viva donde SÍ se deduce: los caminos de cobro
 * (`payment.tpv.service.ts`, `payCashOrder`) y el aplicador de postings, que
 * calculan `effectiveQuantity = weightQuantity ?? quantity`.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { updateOrder } from '../../../../src/services/dashboard/order.dashboard.service'
import { deductInventoryForProduct } from '../../../../src/services/dashboard/productInventoryIntegration.service'

jest.mock('../../../../src/services/dashboard/productInventoryIntegration.service', () => ({
  deductInventoryForProduct: jest.fn().mockResolvedValue({ inventoryMethod: 'RECIPE' }),
}))

const VENUE_ID = 'venue-1'
const ORDER_ID = 'order-1'

const makeItem = (overrides: Record<string, any> = {}) => ({
  id: 'item-1',
  productId: 'product-1',
  productName: 'Carnitas',
  quantity: 1,
  weightQuantity: null,
  modifiers: [],
  product: { id: 'product-1', name: 'Carnitas' },
  ...overrides,
})

describe('updateOrder — ya no toca inventario (ni pesado ni normal)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (callback: (client: typeof prismaMock) => unknown) => callback(prismaMock))
    prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = Array.isArray(query) ? query.join(' ') : ''
      if (sql.includes('FROM "Venue"')) return [{ id: VENUE_ID }]
      if (sql.includes('FROM "Order"')) return [{ id: ORDER_ID }]
      throw new Error('Unexpected weighted-order topology SQL')
    })
    prismaMock.order.findMany.mockResolvedValue([
      { id: ORDER_ID, tableId: null, status: 'PENDING', paymentStatus: 'PENDING', createdAt: new Date('2026-10-01T00:00:00Z') },
    ])
    prismaMock.table.findMany.mockResolvedValue([])

    prismaMock.order.findFirst.mockResolvedValue({ status: 'PENDING', venueId: VENUE_ID } as any)
  })

  it('línea PESADA: completar desde el dashboard no deduce (antes deducía los kilos)', async () => {
    const items = [makeItem({ weightQuantity: new Decimal('0.435') })]
    prismaMock.order.update.mockResolvedValue({ id: ORDER_ID, venueId: VENUE_ID, status: 'COMPLETED', items } as any)

    await updateOrder(VENUE_ID, ORDER_ID, { status: 'COMPLETED', staffId: 'staff-1' } as any)

    expect(deductInventoryForProduct).not.toHaveBeenCalled()
  })

  it('línea NORMAL: completar desde el dashboard tampoco deduce', async () => {
    const items = [makeItem({ quantity: 3 })]
    prismaMock.order.update.mockResolvedValue({ id: ORDER_ID, venueId: VENUE_ID, status: 'COMPLETED', items } as any)

    await updateOrder(VENUE_ID, ORDER_ID, { status: 'COMPLETED', staffId: 'staff-1' } as any)

    expect(deductInventoryForProduct).not.toHaveBeenCalled()
  })
})
