import { withVariantFields } from '@/services/product-variants/variantPayload'

describe('withVariantFields', () => {
  it('suelto: los 4 campos van en null y no cambia nada más', () => {
    const r = withVariantFields({ id: 'p1', name: 'Suelto', productGroupId: null })
    expect(r).toEqual({
      id: 'p1',
      name: 'Suelto',
      productGroupId: null,
      productGroupName: null,
      productGroupImageUrl: null,
      variantOptions: null,
    })
  })
  it('variante: nombre e imagen del padre y opciones ordenadas por eje', () => {
    const r = withVariantFields({
      id: 'p2',
      name: 'Playera · M · Azul',
      productGroupId: 'g1',
      productGroup: { id: 'g1', name: 'Playera', imageUrl: 'https://img/p.png' },
      variantValues: [
        { option: { name: 'Color', position: 1 }, optionValue: { value: 'Azul', position: 0 } },
        { option: { name: 'Talla', position: 0 }, optionValue: { value: 'M', position: 1 } },
      ],
    })
    expect(r).toMatchObject({ productGroupName: 'Playera', productGroupImageUrl: 'https://img/p.png' })
    expect(r.variantOptions).toEqual([
      { name: 'Talla', value: 'M', namePosition: 0, valuePosition: 1 },
      { name: 'Color', value: 'Azul', namePosition: 1, valuePosition: 0 },
    ])
    expect(r).not.toHaveProperty('productGroup')
    expect(r).not.toHaveProperty('variantValues')
  })
  it('🔴 nunca produce un campo «variants» (Android lo lee con price:Double e iOS con price:String?)', () => {
    expect(withVariantFields({ id: 'x', productGroupId: null })).not.toHaveProperty('variants')
  })
})
