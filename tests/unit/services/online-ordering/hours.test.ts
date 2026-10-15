import { isValidOrderingHours, isWithinHours } from '@/services/online-ordering/hours'
import type { HorarioSemanal } from '@/services/delivery-channels/core/deliveryHours.service'

const TZ = 'America/Mexico_City' // UTC-6 todo el año desde 2022
const day = (enabled: boolean, ranges: Array<[string, string]>) => ({
  enabled,
  ranges: ranges.map(([open, close]) => ({ open, close })),
})
const closed = day(false, [])
const week = (overrides: Partial<HorarioSemanal> = {}): HorarioSemanal => ({
  monday: day(true, [['09:00', '18:00']]),
  tuesday: day(true, [['09:00', '18:00']]),
  wednesday: day(true, [['09:00', '18:00']]),
  thursday: day(true, [['09:00', '18:00']]),
  friday: day(true, [['09:00', '18:00']]),
  saturday: closed,
  sunday: closed,
  ...overrides,
})

describe('isWithinHours', () => {
  it('sin horario configurado no restringe', () => {
    expect(isWithinHours(null, new Date('2026-10-14T20:00:00Z'), TZ)).toBe(true)
    expect(isWithinHours(undefined, new Date('2026-10-14T20:00:00Z'), TZ)).toBe(true)
  })

  it('dentro y fuera de la franja del día, en la zona del venue (no la del servidor)', () => {
    // miércoles 14-oct-2026 12:30 en CDMX = 18:30Z
    expect(isWithinHours(week(), new Date('2026-10-14T18:30:00Z'), TZ)).toBe(true)
    // miércoles 20:00 en CDMX = jueves 02:00Z
    expect(isWithinHours(week(), new Date('2026-10-15T02:00:00Z'), TZ)).toBe(false)
  })

  it('un día cerrado no deja pasar', () => {
    // sábado 17-oct-2026 12:00 CDMX = 18:00Z
    expect(isWithinHours(week(), new Date('2026-10-17T18:00:00Z'), TZ)).toBe(false)
  })

  it('el cierre es exclusivo y la apertura inclusiva', () => {
    expect(isWithinHours(week(), new Date('2026-10-14T15:00:00Z'), TZ)).toBe(true) // 09:00
    expect(isWithinHours(week(), new Date('2026-10-15T00:00:00Z'), TZ)).toBe(false) // 18:00
  })

  it('una franja que cruza la medianoche cubre la madrugada del día siguiente', () => {
    const bar = week({ friday: day(true, [['20:00', '02:00']]), saturday: closed })
    // viernes 16-oct 23:00 CDMX = sábado 05:00Z
    expect(isWithinHours(bar, new Date('2026-10-17T05:00:00Z'), TZ)).toBe(true)
    // sábado 17-oct 01:00 CDMX = 07:00Z (todavía es la franja del viernes)
    expect(isWithinHours(bar, new Date('2026-10-17T07:00:00Z'), TZ)).toBe(true)
    // sábado 17-oct 03:00 CDMX = 09:00Z
    expect(isWithinHours(bar, new Date('2026-10-17T09:00:00Z'), TZ)).toBe(false)
  })
})

describe('isValidOrderingHours (H5: la ÚNICA validación del horario de pedidos)', () => {
  it('acepta un horario nocturno que cruza la medianoche (22:00–02:00) y días cerrados sin franjas', () => {
    expect(isValidOrderingHours(week({ friday: day(true, [['22:00', '02:00']]) }))).toBe(true)
  })

  it('rechaza horas imposibles, un día abierto sin franjas, una franja de largo cero, más de 4 franjas o un día faltante', () => {
    expect(isValidOrderingHours(week({ monday: day(true, [['25:00', '30:00']]) }))).toBe(false)
    expect(isValidOrderingHours(week({ monday: day(true, [['9:00', '18:00']]) }))).toBe(false) // HH:MM con dos dígitos
    expect(isValidOrderingHours(week({ monday: day(true, []) }))).toBe(false)
    expect(isValidOrderingHours(week({ monday: day(true, [['10:00', '10:00']]) }))).toBe(false)
    const cinco = Array.from({ length: 5 }, (): [string, string] => ['09:00', '10:00'])
    expect(isValidOrderingHours(week({ monday: day(true, cinco) }))).toBe(false)
    const { sunday: _sinDomingo, ...incompleta } = week()
    expect(isValidOrderingHours(incompleta)).toBe(false)
    expect(isValidOrderingHours(null)).toBe(false)
  })
})
