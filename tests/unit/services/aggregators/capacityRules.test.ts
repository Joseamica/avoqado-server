// tests/unit/services/aggregators/capacityRules.test.ts
import { resolvePassCap, spotsToPublish, CapacityRuleInput } from '@/services/aggregators/core/capacityRules'

const sabado9 = { id: 's1', capacity: 12, localWeekday: 6, localStartMinute: 9 * 60 }
const r = (x: Partial<CapacityRuleInput>): CapacityRuleInput => ({
  scope: 'DEFAULT',
  weekday: null,
  startMinute: null,
  classSessionId: null,
  maxSpots: 0,
  ...x,
})

describe('resolvePassCap', () => {
  // nuevo
  it('sin reglas, el tope es la capacidad (todos los libres)', () => {
    expect(resolvePassCap([], sabado9)).toBe(12)
  })
  // nuevo
  it('gana la más específica: sesión > día+hora > día > general', () => {
    const reglas = [
      r({ scope: 'DEFAULT', maxSpots: 4 }),
      r({ scope: 'WEEKLY', weekday: 6, maxSpots: 3 }),
      r({ scope: 'WEEKLY', weekday: 6, startMinute: 540, maxSpots: 2 }),
      r({ scope: 'SESSION', classSessionId: 's1', maxSpots: 0 }),
    ]
    expect(resolvePassCap(reglas, sabado9)).toBe(0)
    expect(resolvePassCap(reglas.slice(0, 3), sabado9)).toBe(2)
    expect(resolvePassCap(reglas.slice(0, 2), sabado9)).toBe(3)
    expect(resolvePassCap(reglas.slice(0, 1), sabado9)).toBe(4)
  })
  // nuevo
  it('una regla de otro día u otra hora no aplica', () => {
    expect(
      resolvePassCap(
        [r({ scope: 'WEEKLY', weekday: 1, maxSpots: 1 }), r({ scope: 'WEEKLY', weekday: 6, startMinute: 600, maxSpots: 1 })],
        sabado9,
      ),
    ).toBe(12)
  })
  // nuevo
  it('el tope nunca pasa de la capacidad', () => {
    expect(resolvePassCap([r({ scope: 'DEFAULT', maxSpots: 50 })], sabado9)).toBe(12)
  })
})

describe('spotsToPublish', () => {
  // nuevo
  it('publica el menor entre lo que queda del tope y los libres reales', () => {
    expect(spotsToPublish({ capacity: 12, occupied: 5, passOccupied: 1, cap: 4, providerActive: 1 })).toBe(4) // 1 usado + 3 libres del tope
    expect(spotsToPublish({ capacity: 12, occupied: 11, passOccupied: 1, cap: 4, providerActive: 1 })).toBe(2) // sólo queda 1 libre real
  })
  // nuevo
  it('clase llena por clientes propios: publica sólo lo ya reservado por ese proveedor', () => {
    expect(spotsToPublish({ capacity: 12, occupied: 12, passOccupied: 2, cap: 4, providerActive: 2 })).toBe(2)
  })
  // nuevo — Review Focus: TotalPass responde 422 si el cupo baja de sus reservas activas
  it('nunca publica menos que las reservas activas del proveedor', () => {
    expect(spotsToPublish({ capacity: 12, occupied: 12, passOccupied: 3, cap: 0, providerActive: 3 })).toBe(3)
  })
})
