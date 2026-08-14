/**
 * Venta por peso × modificadores ADDITION — fase 3 del plan de inventario.
 *
 * En una línea pesada, los callers pasan `quantity` = KILOS pesados
 * (effectiveQuantity), y las líneas pesadas siempre llevan quantity=1. El
 * modificador ADDITION ("extra salsa": 50 ml por selección) es POR LÍNEA, no
 * por kilo: escalarlo por los kilos deducía 0.435× (o 2.5×) lo configurado.
 *
 * La RECETA sí escala por kilos (sus líneas están definidas por kg) — solo el
 * escalado del modificador cambia. El fix vive DENTRO de
 * deductInventoryForProduct para cubrir a todos los callers (TPV, pagos,
 * payment links, dashboard) sin tocarlos.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { prismaMock } from '../../../__helpers__/setup'
import { deductInventoryForProduct } from '../../../../src/services/dashboard/productInventoryIntegration.service'
import { deductStockForModifiers, deductStockForRecipe } from '../../../../src/services/dashboard/rawMaterial.service'

jest.mock('../../../../src/services/dashboard/rawMaterial.service', () => {
  const actual = jest.requireActual('../../../../src/services/dashboard/rawMaterial.service')
  return {
    ...actual,
    deductStockForRecipe: jest.fn(),
    deductStockForModifiers: jest.fn(),
  }
})

const VENUE_ID = 'venue-1'
const PRODUCT_ID = 'product-carnitas'
const ORDER_ID = 'order-1'

const additionModifier = {
  quantity: 1,
  modifier: {
    id: 'mod-salsa',
    name: 'Extra salsa',
    groupId: 'g1',
    rawMaterialId: 'rm-salsa',
    quantityPerUnit: new Decimal(50),
    unit: 'MILLILITER' as any,
    inventoryMode: 'ADDITION' as any,
  },
}

const mockProduct = (overrides: Record<string, any> = {}) => ({
  id: PRODUCT_ID,
  venueId: VENUE_ID,
  name: 'Carnitas',
  trackInventory: true,
  inventoryMethod: 'RECIPE',
  soldByWeight: false,
  recipe: { id: 'recipe-1' },
  externalData: null,
  ...overrides,
})

describe('deductInventoryForProduct — escala del modificador ADDITION en venta por peso', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('producto pesado (RECIPE): la receta escala por kilos, el modificador por LÍNEA (×1)', async () => {
    prismaMock.product.findUnique.mockResolvedValue(mockProduct({ soldByWeight: true }))

    await deductInventoryForProduct(VENUE_ID, PRODUCT_ID, 0.435, ORDER_ID, 'staff-1', [additionModifier] as any)

    // La receta consume por kilo → recibe los kilos pesados.
    expect(deductStockForRecipe).toHaveBeenCalledWith(VENUE_ID, PRODUCT_ID, 0.435, ORDER_ID, 'staff-1', expect.anything(), undefined)
    // El modificador es por línea → escala 1, no 0.435.
    expect(deductStockForModifiers).toHaveBeenCalledWith(VENUE_ID, 1, expect.anything(), ORDER_ID, 'staff-1', undefined)
  })

  it('producto NO pesado (RECIPE): el modificador sigue escalando por unidades de la línea', async () => {
    prismaMock.product.findUnique.mockResolvedValue(mockProduct({ soldByWeight: false }))

    await deductInventoryForProduct(VENUE_ID, PRODUCT_ID, 3, ORDER_ID, 'staff-1', [additionModifier] as any)

    expect(deductStockForRecipe).toHaveBeenCalledWith(VENUE_ID, PRODUCT_ID, 3, ORDER_ID, 'staff-1', expect.anything(), undefined)
    expect(deductStockForModifiers).toHaveBeenCalledWith(VENUE_ID, 3, expect.anything(), ORDER_ID, 'staff-1', undefined)
  })

  it('producto pesado SIN tracking: los modificadores también escalan por línea', async () => {
    prismaMock.product.findUnique.mockResolvedValue(
      mockProduct({ trackInventory: false, inventoryMethod: null, recipe: null, soldByWeight: true }),
    )

    await deductInventoryForProduct(VENUE_ID, PRODUCT_ID, 2.5, ORDER_ID, 'staff-1', [additionModifier] as any)

    expect(deductStockForRecipe).not.toHaveBeenCalled()
    expect(deductStockForModifiers).toHaveBeenCalledWith(VENUE_ID, 1, expect.anything(), ORDER_ID, 'staff-1', undefined)
  })

  it('sin modificadores no consulta soldByWeight ni llama a deductStockForModifiers (regresión)', async () => {
    prismaMock.product.findUnique.mockResolvedValue(mockProduct({ soldByWeight: true }))

    await deductInventoryForProduct(VENUE_ID, PRODUCT_ID, 0.435, ORDER_ID, 'staff-1')

    expect(deductStockForModifiers).not.toHaveBeenCalled()
  })
})
