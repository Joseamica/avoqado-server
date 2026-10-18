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

  // T3: la vuelta de la semana (domingo es el índice 0: el «ayer» del domingo es el sábado, el del lunes es el domingo).
  it('vuelta de semana: la franja nocturna del DOMINGO cubre la madrugada del LUNES', () => {
    const domingoNoche = week({ sunday: day(true, [['20:00', '02:00']]), monday: closed })
    // lunes 19-oct-2026 01:00 CDMX = 07:00Z
    expect(isWithinHours(domingoNoche, new Date('2026-10-19T07:00:00Z'), TZ)).toBe(true)
    // lunes 19-oct 02:00 CDMX = 08:00Z: el cierre es exclusivo
    expect(isWithinHours(domingoNoche, new Date('2026-10-19T08:00:00Z'), TZ)).toBe(false)
  })

  it('vuelta de semana: la franja nocturna del SÁBADO cubre la madrugada del DOMINGO', () => {
    const sabadoNoche = week({ saturday: day(true, [['22:00', '03:00']]), sunday: closed })
    // domingo 18-oct-2026 02:30 CDMX = 08:30Z
    expect(isWithinHours(sabadoNoche, new Date('2026-10-18T08:30:00Z'), TZ)).toBe(true)
    // domingo 18-oct 04:00 CDMX = 10:00Z
    expect(isWithinHours(sabadoNoche, new Date('2026-10-18T10:00:00Z'), TZ)).toBe(false)
  })

  it('la franja nocturna de AYER no cuenta si ayer está apagado (`enabled: false`), aunque traiga la franja', () => {
    const viernesApagado = week({ friday: { enabled: false, ranges: [{ open: '20:00', close: '02:00' }] }, saturday: closed })
    // sábado 17-oct 01:00 CDMX = 07:00Z
    expect(isWithinHours(viernesApagado, new Date('2026-10-17T07:00:00Z'), TZ)).toBe(false)
    const sabadoApagado = week({ saturday: { enabled: false, ranges: [{ open: '22:00', close: '03:00' }] }, sunday: closed })
    // domingo 18-oct 02:30 CDMX = 08:30Z (la vuelta de semana, también apagada)
    expect(isWithinHours(sabadoApagado, new Date('2026-10-18T08:30:00Z'), TZ)).toBe(false)
  })

  it('la franja nocturna de HOY no abre la madrugada de hoy: antes de su apertura sigue cerrado', () => {
    const viernes = week({ friday: day(true, [['20:00', '02:00']]), thursday: closed })
    // viernes 16-oct 01:00 CDMX = 07:00Z: la franja del viernes empieza a las 20:00 y el jueves está cerrado
    expect(isWithinHours(viernes, new Date('2026-10-16T07:00:00Z'), TZ)).toBe(false)
  })
})

describe('isValidOrderingHours (H5: la ÚNICA validación del horario de pedidos)', () => {
  it('acepta un horario nocturno que cruza la medianoche (22:00–02:00) y días cerrados sin franjas', () => {
    expect(isValidOrderingHours(week({ friday: day(true, [['22:00', '02:00']]) }))).toBe(true)
  })

  it('acepta exactamente 4 franjas en un día, los límites 00:00 y 23:59, y un día apagado que conserva sus franjas', () => {
    const cuatro = Array.from({ length: 4 }, (): [string, string] => ['09:00', '10:00'])
    expect(isValidOrderingHours(week({ monday: day(true, cuatro) }))).toBe(true)
    expect(isValidOrderingHours(week({ monday: day(true, [['00:00', '23:59']]) }))).toBe(true)
    expect(isValidOrderingHours(week({ monday: day(false, [['09:00', '18:00']]) }))).toBe(true)
  })

  // T3: caso por caso, cada uno solo, para que una regla que se rompa se vea por su nombre.
  const cinco = Array.from({ length: 5 }, (): [string, string] => ['09:00', '10:00'])
  const sinDomingo = (): Record<string, unknown> => {
    const semana: Record<string, unknown> = { ...week() }
    delete semana.sunday
    return semana
  }
  it.each<[string, unknown]>([
    ['una hora imposible (25:00)', week({ monday: day(true, [['25:00', '30:00']]) })],
    ['minutos imposibles (09:60)', week({ monday: day(true, [['09:60', '18:00']]) })],
    ['24:00 (el máximo es 23:59)', week({ monday: day(true, [['09:00', '24:00']]) })],
    ['una hora de un dígito (9:00)', week({ monday: day(true, [['9:00', '18:00']]) })],
    ['un día abierto sin franjas', week({ monday: day(true, []) })],
    ['una franja de largo cero', week({ monday: day(true, [['10:00', '10:00']]) })],
    ['más de 4 franjas en un día', week({ monday: day(true, cinco) })],
    ['un día faltante (sin domingo)', sinDomingo()],
    ['`enabled` que no es booleano', { ...week(), monday: { enabled: 'true', ranges: [{ open: '09:00', close: '18:00' }] } }],
    ['`ranges` que no es lista', { ...week(), monday: { enabled: true, ranges: { open: '09:00', close: '18:00' } } }],
    ['una franja nula', { ...week(), monday: { enabled: true, ranges: [null] } }],
    ['una apertura que no es texto', { ...week(), monday: { enabled: true, ranges: [{ open: 900, close: '18:00' }] } }],
    ['un cierre faltante', { ...week(), monday: { enabled: true, ranges: [{ open: '09:00' }] } }],
    ['un día nulo', { ...week(), monday: null }],
    ['null', null],
    ['un texto', 'lunes a viernes'],
  ])('rechaza %s', (_caso, horario) => {
    expect(isValidOrderingHours(horario)).toBe(false)
  })
})
