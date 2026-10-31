import { CreateModifierSchema, SKU_FORMAT_MESSAGE, SKU_REGEX, UpdateProductSchema } from '@/schemas/dashboard/menu.schema'

/**
 * D3 (30-oct): el SKU acepta espacios y puntos, porque los códigos de otros POS los traen (MyBusiness, La Galeterie:
 * «Q. AHUMADO», «LALA1.5»). Antes sólo letras, números, guion y guion bajo: un producto importado con esos códigos no se
 * podía guardar desde su ficha (la ficha reenvía el SKU). La Ñ y los acentos siguen fuera: no caben en un Code 128/39 del
 * vale de caja externa y una pistola con otro teclado los escribe mal.
 */
const productParams = { venueId: 'cjld2cjxh0000qzrmn831i7rn', productId: 'cjld2cjxh0003qzrmn831i7rq' }
const modifierParams = {
  venueId: 'cjld2cjxh0000qzrmn831i7rn',
  modifierGroupId: 'cjld2cjxh0001qzrmn831i7ro',
  modifierId: 'cjld2cjxh0002qzrmn831i7rp',
}

describe('Formato del SKU', () => {
  it.each(['Q. AHUMADO', 'LALA1.5', 'JAMON PIERNA H SAN RAFAEL', '50202203-1', 'P000622', 'AB_1', 'a-b', 'X'])(
    '🔴 D3: acepta «%s»',
    sku => {
      expect(SKU_REGEX.test(sku)).toBe(true)
    },
  )

  it.each(['CAFÉ 1', 'VINO TERRUÑO', 'A/B', 'A#1', ' ABC', 'ABC ', '   ', ''])('sigue rechazando «%s»', sku => {
    expect(SKU_REGEX.test(sku)).toBe(false)
  })

  it('la ficha guarda el código sin los espacios de las orillas', () => {
    const r = UpdateProductSchema.safeParse({ params: productParams, body: { sku: '  Q. AHUMADO  ' } })
    expect(r.success).toBe(true)
    expect(r.success && r.data.body.sku).toBe('Q. AHUMADO')
  })

  it('un SKU inválido trae el mensaje en español (la validación lo enseña tal cual)', () => {
    const r = UpdateProductSchema.safeParse({ params: productParams, body: { sku: 'A/B' } })
    expect(r.success).toBe(false)
    expect(JSON.stringify(!r.success && r.error.issues)).toContain(SKU_FORMAT_MESSAGE)
    expect(SKU_FORMAT_MESSAGE).toMatch(/espacios/)
  })

  it('el SKU de un extra (caja externa) acepta el mismo formato', () => {
    const r = CreateModifierSchema.safeParse({ params: modifierParams, body: { name: 'Shot', price: 15, sku: 'P 000672' } })
    expect(r.success).toBe(true)
  })
})
