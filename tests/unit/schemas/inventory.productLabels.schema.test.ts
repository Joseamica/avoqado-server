import { GenerateProductLabelsSchema } from '../../../src/schemas/dashboard/inventory.schema'

// IQ (prod, 13-oct-2026): 273 de sus 281 productos tienen ids que no son cuid v1
// (p. ej. "qq9ig98otlke0iuvsw33fzsso", no empiezan con "c"). `.cuid()` los rechazaba con
// 400 y el dashboard sólo mostraba «Error al generar etiquetas».
const base = {
  params: { venueId: 'cmosvx24400n2kk2akgx4uhgi' },
  body: {
    labelType: 'zebra-1.2x0.85',
    barcodeFormat: 'SKU',
    details: { sku: true, gtin: false, variantName: false, price: true, itemName: true, unitAbbr: false },
    items: [] as Array<{ productId: string; quantity: number }>,
  },
}

const withIds = (...ids: string[]) => ({ ...base, body: { ...base.body, items: ids.map(productId => ({ productId, quantity: 1 })) } })

describe('GenerateProductLabelsSchema', () => {
  it('acepta ids de producto que no son cuid v1 (productos de IQ)', () => {
    expect(GenerateProductLabelsSchema.safeParse(withIds('qq9ig98otlke0iuvsw33fzsso', 'prod_ad_blanq_003')).success).toBe(true)
  })

  it('sigue aceptando cuid v1', () => {
    expect(GenerateProductLabelsSchema.safeParse(withIds('cgtj8tf4paf1jrexpryugnv0u')).success).toBe(true)
  })

  it('sigue rechazando basura', () => {
    expect(GenerateProductLabelsSchema.safeParse(withIds("x'; DROP TABLE")).success).toBe(false)
    expect(GenerateProductLabelsSchema.safeParse(withIds('')).success).toBe(false)
  })
})
