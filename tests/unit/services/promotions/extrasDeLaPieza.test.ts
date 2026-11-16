import { revisarExtrasDeLaPieza, leerModifierIds, type ExtraDelVenue, type GrupoDeLaPieza } from '@/services/promotions/extrasDeLaPieza'

const grupo = (over: Partial<GrupoDeLaPieza> = {}): GrupoDeLaPieza => ({
  id: 'g-termino',
  name: 'Término',
  required: false,
  allowMultiple: true,
  minSelections: 0,
  maxSelections: null,
  ...over,
})

const extra = (id: string, name: string, priceCents: number, groupId = 'g-termino'): ExtraDelVenue => ({ id, name, priceCents, groupId })

const venue = (...extras: ExtraDelVenue[]) => new Map(extras.map(e => [e.id, e]))

const base = {
  productName: 'Hamburguesa',
  quantity: 1,
  gruposDelProducto: [grupo()],
  extrasDelVenue: venue(extra('queso', 'Queso', 1500), extra('tocino', 'Tocino', 2000, 'g-otro')),
}

describe('revisarExtrasDeLaPieza', () => {
  it('sin llave no revisa nada', () => {
    expect(revisarExtrasDeLaPieza({ ...base, modifierIds: undefined, gruposDelProducto: [grupo({ required: true })] })).toEqual({
      extras: [],
      extrasCents: 0,
      problemas: [],
    })
  })

  it('cobra cada ocurrencia', () => {
    const r = revisarExtrasDeLaPieza({ ...base, modifierIds: ['queso', 'queso'] })
    expect(r.extras).toEqual([
      { modifierId: 'queso', name: 'Queso', priceCents: 1500 },
      { modifierId: 'queso', name: 'Queso', priceCents: 1500 },
    ])
    expect(r.extrasCents).toBe(3000)
    expect(r.problemas).toEqual([])
  })

  it('obligatorio faltante', () => {
    const r = revisarExtrasDeLaPieza({ ...base, modifierIds: [], gruposDelProducto: [grupo({ required: true })] })
    expect(r.problemas).toEqual(['Faltó elegir «Término» de Hamburguesa.'])
  })

  it('required con minSelections 0 pide 1', () => {
    const g = grupo({ required: true, minSelections: 0 })
    expect(revisarExtrasDeLaPieza({ ...base, modifierIds: [], gruposDelProducto: [g] }).problemas).toHaveLength(1)
    expect(revisarExtrasDeLaPieza({ ...base, modifierIds: ['queso'], gruposDelProducto: [g] }).problemas).toEqual([])
  })

  it('required con minSelections 2 pide 2', () => {
    const g = grupo({ required: true, minSelections: 2 })
    expect(revisarExtrasDeLaPieza({ ...base, modifierIds: ['queso'], gruposDelProducto: [g] }).problemas).toEqual([
      'Faltó elegir «Término» de Hamburguesa.',
    ])
  })

  it('selección única sin máximo con dos: problema y se cobran los dos', () => {
    const g = grupo({ allowMultiple: false, maxSelections: null })
    const ev = venue(extra('a', 'A', 100), extra('b', 'B', 200))
    const r = revisarExtrasDeLaPieza({ ...base, modifierIds: ['a', 'b'], gruposDelProducto: [g], extrasDelVenue: ev })
    expect(r.problemas).toEqual(['«Término» de Hamburguesa admite sólo 1 opción.'])
    expect(r.extras).toHaveLength(2)
    expect(r.extrasCents).toBe(300)
  })

  it('máximo excedido: problema y se cobran los 3', () => {
    const g = grupo({ allowMultiple: true, maxSelections: 2 })
    const r = revisarExtrasDeLaPieza({ ...base, modifierIds: ['queso', 'queso', 'queso'], gruposDelProducto: [g] })
    expect(r.problemas).toEqual(['«Término» de Hamburguesa admite sólo 2 opciones.'])
    expect(r.extras).toHaveLength(3)
  })

  it('id que no es del venue se omite', () => {
    const r = revisarExtrasDeLaPieza({ ...base, modifierIds: ['fantasma', 'queso'] })
    expect(r.extras.map(e => e.modifierId)).toEqual(['queso'])
    expect(r.problemas).toEqual(['Un extra de Hamburguesa ya no existe y no se cobró.'])
  })

  it('extra de otro producto: se cobra y se marca', () => {
    const r = revisarExtrasDeLaPieza({ ...base, modifierIds: ['tocino'] })
    expect(r.extras).toEqual([{ modifierId: 'tocino', name: 'Tocino', priceCents: 2000 }])
    expect(r.extrasCents).toBe(2000)
    expect(r.problemas).toEqual(['«Tocino» no es un extra de Hamburguesa.'])
  })

  it('pieza con cantidad 2 ignora extras', () => {
    const r = revisarExtrasDeLaPieza({ ...base, quantity: 2, modifierIds: ['queso'] })
    expect(r.extras).toEqual([])
    expect(r.extrasCents).toBe(0)
    expect(r.problemas).toEqual(['Hamburguesa viene 2 veces en el combo: sus extras no se cobraron.'])
    expect(revisarExtrasDeLaPieza({ ...base, quantity: 2, modifierIds: [] }).problemas).toEqual([])
  })
})

describe('leerModifierIds', () => {
  it('lee arrays de strings sin tope', () => {
    expect(leerModifierIds(['a'])).toEqual(['a'])
    expect(leerModifierIds([])).toEqual([])
    const sesenta = Array.from({ length: 60 }, (_, i) => `m${i}`)
    expect(leerModifierIds(sesenta)).toEqual(sesenta)
  })

  it('lo que no es un array de strings es undefined', () => {
    expect(leerModifierIds('a')).toBeUndefined()
    expect(leerModifierIds([1])).toBeUndefined()
    expect(leerModifierIds(null)).toBeUndefined()
    expect(leerModifierIds(undefined)).toBeUndefined()
  })
})
