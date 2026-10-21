import { llegoAlTopePersonas, TOPE_PERSONAS_POR_SEDE } from '@/services/dashboard/staffPay/valoracion'

describe('valoración — tope de personas por sede («nada se trunca»)', () => {
  it('sólo marca truncado cuando la sede devolvió exactamente el tope (o más)', () => {
    expect(TOPE_PERSONAS_POR_SEDE).toBe(2000)
    expect(llegoAlTopePersonas(0)).toBe(false)
    expect(llegoAlTopePersonas(TOPE_PERSONAS_POR_SEDE - 1)).toBe(false)
    expect(llegoAlTopePersonas(TOPE_PERSONAS_POR_SEDE)).toBe(true)
  })
})
