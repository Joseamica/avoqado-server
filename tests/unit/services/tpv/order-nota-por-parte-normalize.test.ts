/**
 * D40 (Flautas Coyoacán): la nota de cada parte del paquete en una ronda. `normalizeAddItems` arma objetos nuevos campo por campo:
 * sin pasarla a mano, `modifierNotes` se perdía; y dos renglones iguales salvo por la nota de una parte son DOS renglones.
 */
import { normalizeAddItems } from '@/services/tpv/order.tpv.service'

const paquete = { productId: 'prod-paquete', quantity: 1, modifierIds: ['consome', 'cochinita', 'cochinita'] }

describe('normalizeAddItems — D40 nota por parte', () => {
  it('P1 la nota de cada parte sobrevive a la normalización', () => {
    const [r] = normalizeAddItems([{ ...paquete, modifierNotes: { consome: ' sin cebolla ', cochinita: 'salsa combinada' } }])
    expect(r.modifierNotes).toEqual({ consome: 'sin cebolla', cochinita: 'salsa combinada' })
  })

  it('P1 iguales salvo por la nota de una parte NO se suman', () => {
    const r = normalizeAddItems([{ ...paquete, modifierNotes: { consome: 'sin cebolla' } }, { ...paquete }])
    expect(r).toHaveLength(2)
  })

  it('P1 sin notas se juntan como siempre y no aparece la llave', () => {
    const r = normalizeAddItems([{ ...paquete }, { ...paquete, modifierNotes: { ajeno: 'x', consome: '  ' } }])
    expect(r).toHaveLength(1)
    expect(r[0].quantity).toBe(2)
    expect('modifierNotes' in r[0]).toBe(false)
  })

  it('P2 la misma nota escrita igual se junta', () => {
    const r = normalizeAddItems([
      { ...paquete, modifierNotes: { consome: 'sin cebolla', cochinita: 'salsa' } },
      { ...paquete, modifierNotes: { cochinita: 'salsa', consome: 'sin  cebolla' } },
    ])
    expect(r).toHaveLength(1)
  })
})
