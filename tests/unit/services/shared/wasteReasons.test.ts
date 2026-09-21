import { WASTE_REASON_CODES, WASTE_REASONS, isWasteReasonCode } from '@/services/shared/wasteReasons'

describe('catálogo de motivos de merma', () => {
  it('son los 20 del dashboard más UNSPECIFIED', () => {
    expect(WASTE_REASON_CODES).toHaveLength(21)
    expect(new Set(WASTE_REASON_CODES).size).toBe(21)
    expect(Object.keys(WASTE_REASONS).sort()).toEqual([...WASTE_REASON_CODES].sort())
  })

  it('🔴 exactamente 7 son de mostrador, y son los del spec', () => {
    const pos = WASTE_REASON_CODES.filter(code => WASTE_REASONS[code].pos).sort()
    expect(pos).toEqual(['DEFECTIVE', 'DROPPED', 'EXPIRED', 'MISSING', 'OTHER', 'PREP_ERROR', 'SPOILED'])
  })

  it('🔴 el chip «Robo o faltante» guarda MISSING; THEFT no se ofrece en el POS', () => {
    expect(WASTE_REASONS.MISSING).toMatchObject({ label: 'Robo o faltante', pos: true })
    expect(WASTE_REASONS.THEFT.pos).toBe(false)
  })

  it('UNSPECIFIED existe sólo para el adaptador del dashboard', () => {
    expect(WASTE_REASONS.UNSPECIFIED.pos).toBe(false)
  })

  it('🔴 no acepta llaves heredadas del prototipo', () => {
    expect(isWasteReasonCode('EXPIRED')).toBe(true)
    expect(isWasteReasonCode('toString')).toBe(false)
    expect(isWasteReasonCode('__proto__')).toBe(false)
  })
})
