import { createCreditPackSchema, updateCreditPackSchema } from '../../../../src/schemas/dashboard/creditPack.schema'

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
