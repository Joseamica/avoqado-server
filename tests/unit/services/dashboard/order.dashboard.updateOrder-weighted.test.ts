/**
 * updateOrder (dashboard) — deducción por peso, fase 3 del plan de inventario.
 *
 * Al completar una orden desde el dashboard, la deducción pasaba
 * `item.quantity` (siempre 1 en líneas pesadas) en vez de
 * `item.weightQuantity` (los kilos): vender 435 g deducía 1 kilo. El TPV y los
 * pagos ya calculan `effectiveQuantity = weightQuantity ?? quantity`; el
 * dashboard era el único camino sin la corrección.
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

describe('updateOrder — la línea pesada deduce los KILOS, no quantity', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.order.findFirst.mockResolvedValue({ status: 'PENDING', venueId: VENUE_ID })
  })

  it('línea pesada: pasa weightQuantity (0.435 kg) a la deducción', async () => {
    prismaMock.order.update.mockResolvedValue({
      id: ORDER_ID,
      venueId: VENUE_ID,
      status: 'COMPLETED',
      servedById: 'staff-1',
      items: [makeItem({ quantity: 1, weightQuantity: new Decimal('0.435') })],
    })

    await updateOrder(VENUE_ID, ORDER_ID, { status: 'COMPLETED' } as any)

    expect(deductInventoryForProduct).toHaveBeenCalledWith(VENUE_ID, 'product-1', 0.435, ORDER_ID, 'staff-1', expect.anything())
  })

  it('línea normal: sigue pasando quantity (regresión)', async () => {
    prismaMock.order.update.mockResolvedValue({
      id: ORDER_ID,
      venueId: VENUE_ID,
      status: 'COMPLETED',
      servedById: 'staff-1',
      items: [makeItem({ quantity: 3, weightQuantity: null })],
    })

    await updateOrder(VENUE_ID, ORDER_ID, { status: 'COMPLETED' } as any)

    expect(deductInventoryForProduct).toHaveBeenCalledWith(VENUE_ID, 'product-1', 3, ORDER_ID, 'staff-1', expect.anything())
  })
})
