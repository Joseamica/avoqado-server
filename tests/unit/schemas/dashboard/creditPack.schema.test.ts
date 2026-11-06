import { updateCreditPackSchema } from '../../../../src/schemas/dashboard/creditPack.schema'

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
