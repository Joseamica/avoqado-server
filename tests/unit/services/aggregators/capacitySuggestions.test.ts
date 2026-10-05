// tests/unit/services/aggregators/capacitySuggestions.test.ts
import { suggestPassCaps, SlotHistory } from '@/services/aggregators/core/capacitySuggestions'

const sab9 = (week: string, own: number): SlotHistory => ({
  localWeekday: 6,
  localStartMinute: 540,
  capacity: 12,
  ownOccupied: own,
  weekKey: week,
})

describe('suggestPassCaps', () => {
  // nuevo
  it('con menos de 3 semanas no sugiere nada', () => {
    expect(suggestPassCaps([sab9('2026-W38', 11), sab9('2026-W39', 12)])).toEqual([])
  })
  // nuevo
  it('clase que se llena con clientes propios ⇒ sugiere 0 o 1', () => {
    const h = ['W33', 'W34', 'W35', 'W36', 'W37', 'W38', 'W39', 'W40'].map(w => sab9(`2026-${w}`, 11 + (w === 'W40' ? 1 : 0)))
    const [s] = suggestPassCaps(h)
    expect(s).toMatchObject({ localWeekday: 6, localStartMinute: 540, weeksOfData: 8, capacity: 12 })
    expect(s.suggestedMaxSpots).toBe(0) // 12 − p75(11..12)=11 − 1 = 0
  })
  // nuevo
  it('clase medio vacía ⇒ sugiere más lugares, con un lugar de margen', () => {
    const h = ['W37', 'W38', 'W39', 'W40'].map(w => sab9(`2026-${w}`, 5))
    expect(suggestPassCaps(h)[0].suggestedMaxSpots).toBe(6) // 12 − 5 − 1
  })
  // nuevo
  it('agrupa por día y hora, y una semana con dos sesiones iguales cuenta una vez', () => {
    const h = [sab9('2026-W38', 4), sab9('2026-W38', 6), sab9('2026-W39', 4), sab9('2026-W40', 4)]
    expect(suggestPassCaps(h)[0].weeksOfData).toBe(3)
  })
})
