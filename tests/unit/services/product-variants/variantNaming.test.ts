import { ProductType } from '@prisma/client'
import { SKU_REGEX } from '@/schemas/dashboard/menu.schema'
import {
  isWholeCents,
  MAX_OPTIONS,
  MAX_VALUES_PER_OPTION,
  assertAllowedGroupType,
  normalizeOptions,
  suggestSku,
  variantKeyOf,
  variantName,
} from '@/services/product-variants/variantNaming'

describe('normalizeOptions', () => {
  it('recorta espacios y conserva el orden', () => {
    expect(normalizeOptions([{ name: ' Talla ', values: [' S', 'M ', 'L'] }])).toEqual([{ name: 'Talla', values: ['S', 'M', 'L'] }])
  })
  it('🔴 rechaza valores repetidos sin importar mayúsculas ni espacios («M», « m »)', () => {
    expect(() => normalizeOptions([{ name: 'Talla', values: ['M', ' m '] }])).toThrow(/«m» está repetido en Talla/i)
  })
  it('rechaza valores vacíos', () => {
    expect(() => normalizeOptions([{ name: 'Talla', values: ['S', '  '] }])).toThrow(/vacío/)
  })
  it('rechaza nombres de opción repetidos', () => {
    expect(() =>
      normalizeOptions([
        { name: 'Talla', values: ['S'] },
        { name: 'talla', values: ['M'] },
      ]),
    ).toThrow(/repetida/)
  })
  it(`rechaza más de ${MAX_OPTIONS} opciones`, () => {
    const o = (n: string) => ({ name: n, values: ['x'] })
    expect(() => normalizeOptions([o('A'), o('B'), o('C'), o('D')])).toThrow(/3 opciones/)
  })
  it(`rechaza más de ${MAX_VALUES_PER_OPTION} valores`, () => {
    expect(() => normalizeOptions([{ name: 'N', values: Array.from({ length: 101 }, (_, i) => `v${i}`) }])).toThrow(/100 valores/)
  })
  it('rechaza ninguna opción', () => {
    expect(() => normalizeOptions([])).toThrow(/al menos una opción/)
  })
})

describe('variantName', () => {
  it('une padre y valores con « · », igual que el conector Shopify', () => {
    expect(variantName('Playera básica', ['M', 'Azul'])).toBe('Playera básica · M · Azul')
  })
})

describe('variantKeyOf', () => {
  it('une los ids en el orden dado', () => {
    expect(variantKeyOf(['c1', 'c2'])).toBe('c1|c2')
    expect(variantKeyOf(['c2', 'c1'])).toBe('c2|c1')
  })
})

describe('suggestSku', () => {
  it('mayúsculas, sin acentos, sin espacios; cumple SKU_REGEX', () => {
    expect(suggestSku('Playera básica', ['M', 'Azul cielo'])).toBe('PLAYERA-BASICA-M-AZUL-CIELO')
    expect(suggestSku('Playera básica', ['M', 'Azul cielo'])).toMatch(SKU_REGEX)
  })
  it('caracteres raros se vuelven guiones y no quedan guiones dobles', () => {
    expect(suggestSku('Café ¡grande!', ['1/2 kg'])).toBe('CAFE-GRANDE-1-2-KG')
  })
  it('nunca pasa de 64 caracteres', () => {
    expect(suggestSku('x'.repeat(80), ['y'.repeat(30)]).length).toBeLessThanOrEqual(64)
  })
})

describe('assertAllowedGroupType', () => {
  it('acepta productos físicos y de consumo', () => {
    expect(() => assertAllowedGroupType(ProductType.REGULAR)).not.toThrow()
    expect(() => assertAllowedGroupType(ProductType.FOOD_AND_BEV)).not.toThrow()
  })
  it('rechaza servicios, clases y eventos (fase posterior)', () => {
    expect(() => assertAllowedGroupType(ProductType.APPOINTMENTS_SERVICE)).toThrow(/todavía no/)
    expect(() => assertAllowedGroupType(ProductType.CLASS)).toThrow(/todavía no/)
  })
})

describe('isWholeCents', () => {
  it('acepta pesos con hasta 2 decimales', () => {
    for (const n of [0.01, 19.99, 100, 10_000_000]) expect(isWholeCents(n)).toBe(true)
  })
  it('🔴 rechaza más de 2 decimales, también los diminutos que se guardarían como 0.00', () => {
    for (const n of [19.999, 0.005, 1e-7, 1e-9, Number.NaN, Number.POSITIVE_INFINITY]) expect(isWholeCents(n)).toBe(false)
  })
})
