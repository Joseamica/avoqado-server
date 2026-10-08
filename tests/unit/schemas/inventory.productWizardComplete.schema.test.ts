/**
 * Regression — «Nuevo producto» del dashboard perdía el SKU y el código de barras.
 *
 * Bug (La Galeterie, 5-oct-2026): se dio de alta «SANDWICH ITALIANO» con SKU `P000701` (su código en MyBusiness, el
 * que imprime el vale de caja externa) y quedó `SKU-1791246301488`. El asistente manda `product.sku`/`product.gtin` a
 * `/wizard/complete`, pero este esquema no los declaraba: zod los tira y `validateRequest` reemplaza `req.body` con lo
 * validado, así que el servicio nunca los veía y autogeneraba el SKU. Desde abril, 86 productos creados así en prod.
 */

import { CreateProductWithInventorySchema } from '@/schemas/dashboard/inventory.schema'

const CUID = 'cjld2cjxh0000qzrmn831i7rn'

const peticion = (product: Record<string, unknown>) => ({
  params: { venueId: CUID },
  body: {
    product: { name: 'SANDWICH ITALIANO', price: 73, categoryId: CUID, type: 'FOOD_AND_BEV', ...product },
    inventory: { useInventory: false },
  },
})

describe('CreateProductWithInventorySchema — códigos del producto', () => {
  it('conserva el SKU y el código de barras que tecleó el usuario', () => {
    const result = CreateProductWithInventorySchema.safeParse(peticion({ sku: 'P000701', gtin: '7501234567890' }))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.body.product.sku).toBe('P000701')
      expect(result.data.body.product.gtin).toBe('7501234567890')
    }
  })

  it('rechaza un SKU más largo de lo que acepta el paso 1 (64)', () => {
    expect(CreateProductWithInventorySchema.safeParse(peticion({ sku: 'X'.repeat(65) })).success).toBe(false)
  })

  // Mismo defecto, mismos campos que el asistente manda y se tiraban: modificadores, venta por peso y claves SAT.
  it('conserva modificadores, venta por peso y claves SAT', () => {
    const extras = {
      modifierGroupIds: [CUID],
      soldByWeight: true,
      satProductKey: '50181900',
      satUnitKey: 'H87',
      objetoImp: '02',
    }
    const result = CreateProductWithInventorySchema.safeParse(peticion(extras))
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.body.product).toMatchObject(extras)
  })

  it('valida las claves SAT igual que el alta normal', () => {
    expect(CreateProductWithInventorySchema.safeParse(peticion({ satProductKey: '123' })).success).toBe(false)
    expect(CreateProductWithInventorySchema.safeParse(peticion({ objetoImp: '09' })).success).toBe(false)
  })

  // Regresión: sin códigos sigue siendo válido (el servicio autogenera el SKU).
  it('sin SKU ni código de barras sigue siendo válido', () => {
    const result = CreateProductWithInventorySchema.safeParse(peticion({}))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.body.product.sku).toBeUndefined()
      expect(result.data.body.product.gtin).toBeUndefined()
    }
  })
})
