import {
  createCreditPackSchema,
  updateCreditPackSchema,
  CREDIT_PACK_BADGE_ICONS,
} from '../../../../src/schemas/dashboard/creditPack.schema'

// «A la venta» del DASHBOARD manda PATCH {active}. Zod descartaba `active` en silencio
// (200 sin guardar). El body que llega al servicio debe conservarlo.
describe('updateCreditPackSchema.active', () => {
  const parse = (body: unknown) => updateCreditPackSchema.parse({ params: { packId: 'p1' }, body }).body

  it.each([false, true])('conserva active=%s', active => {
    expect(parse({ active })).toEqual({ active })
  })

  it('rechaza un active que no es booleano', () => {
    expect(() => parse({ active: 'no' })).toThrow()
  })
})

// D679: un renglón Ilimitado no trae cantidad (la pone el servidor); uno normal sin cantidad lo rechaza el servicio.
describe('renglón Ilimitado (D679)', () => {
  const alta = (items: unknown) =>
    createCreditPackSchema.parse({ body: { name: 'Ilimitado', price: 2500, validityDays: 30, items } }).body.items

  it('acepta renglón con unlimited sin quantity', () => {
    expect(alta([{ productId: 'p1', unlimited: true }])).toEqual([{ productId: 'p1', unlimited: true }])
    expect(
      updateCreditPackSchema.parse({ params: { packId: 'x' }, body: { items: [{ productId: 'p1', unlimited: true }] } }).body.items,
    ).toEqual([{ productId: 'p1', unlimited: true }])
  })

  it('una cantidad de 0 sigue siendo inválida, con su texto', () => {
    expect(() => alta([{ productId: 'p1', quantity: 0 }])).toThrow('La cantidad debe ser mayor a 0')
  })

  it('unlimited que no es booleano se rechaza', () => {
    expect(() => alta([{ productId: 'p1', unlimited: 'si' }])).toThrow()
  })
})

// Destacado del paquete: etiqueta (1–40) e ícono de una lista fija.
describe('destacado del paquete (badgeText / badgeIcon)', () => {
  const items = [{ productId: 'p1', quantity: 10 }]
  const alta = (extra: Record<string, unknown>) =>
    createCreditPackSchema.parse({ body: { name: 'Paquete', price: 100, items, ...extra } }).body
  const cambio = (body: Record<string, unknown>) => updateCreditPackSchema.parse({ params: { packId: 'p1' }, body }).body

  it('la lista de íconos es la acordada', () => {
    expect([...CREDIT_PACK_BADGE_ICONS]).toEqual(['star', 'tag', 'flame', 'heart', 'sparkles', 'trophy'])
  })

  it('acepta texto e ícono', () => {
    expect(alta({ badgeText: 'Más popular', badgeIcon: 'star' })).toMatchObject({ badgeText: 'Más popular', badgeIcon: 'star' })
  })

  it('rechaza más de 40 caracteres', () => {
    expect(() => alta({ badgeText: 'x'.repeat(41) })).toThrow('La etiqueta es de máximo 40 caracteres')
  })

  it('rechaza un ícono que no está en la lista', () => {
    expect(() => alta({ badgeText: 'Hola', badgeIcon: 'rocket' })).toThrow('Ícono no válido')
  })

  it('rechaza un ícono sin texto', () => {
    expect(() => alta({ badgeIcon: 'star' })).toThrow('Escribe la etiqueta del destacado')
    expect(() => alta({ badgeText: '   ', badgeIcon: 'star' })).toThrow('Escribe la etiqueta del destacado')
  })

  it('un texto vacío queda null', () => {
    expect(alta({ badgeText: '' }).badgeText).toBeNull()
    expect(alta({ badgeText: '   ' }).badgeText).toBeNull()
  })

  it('el cambio acepta quitar el destacado con null', () => {
    expect(cambio({ badgeText: null, badgeIcon: null })).toEqual({ badgeText: null, badgeIcon: null })
  })

  it('un cambio sin esas llaves no las agrega', () => {
    expect(cambio({ name: 'Otro' })).toEqual({ name: 'Otro' })
  })
})
