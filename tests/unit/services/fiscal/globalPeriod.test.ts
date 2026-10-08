// tests/unit/services/fiscal/globalPeriod.test.ts
//
// Pure unit tests for closedPeriodFor — injects 'now' so no Date mocking is needed.
// All assertions verify Mexico-timezone boundaries.
//
// IMPORTANT: Mexico City (America/Mexico_City) eliminated DST in 2023 via Decree.
// As of 2023, Mexico City is permanently CST (UTC-6) year-round. There is no CDT season.
// All UTC offsets for Mexico City dates in 2026 are therefore UTC-6 = "T06:00:00Z" at midnight.

import { closedPeriodFor } from '../../../../src/services/fiscal/globalPeriod'

// Helpers: create a Date that corresponds to a given Mexico-local date at noon.
// Since Mexico City is permanently UTC-6 (no DST since 2023), we always use -06:00.
function mxNoon(year: number, month: number, day: number): Date {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return new Date(`${year}-${m}-${d}T12:00:00-06:00`)
}

// Mexico midnight UTC offset (permanently UTC-6 since 2023 DST elimination)
// "2026-MM-DD 00:00 Mexico City" = "2026-MM-DDT06:00:00.000Z"
const MX_MIDNIGHT_OFFSET = '06:00:00.000Z'

describe('closedPeriodFor — MENSUAL', () => {
  it('Jun 3 → closed period = May 2026', () => {
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('MENSUAL', now)
    expect(p.meses).toBe('05')
    expect(p.anio).toBe(2026)
    expect(p.satPeriodicidad).toBe('04')
    expect(p.facturaPeriodicity).toBe('month')
    // periodStart = 2026-05-01 00:00 MX = 2026-05-01T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2026-05-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-06-01 00:00 MX = 2026-06-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Jan 1 → closed period = Dec of previous year', () => {
    const now = mxNoon(2026, 1, 1)
    const p = closedPeriodFor('MENSUAL', now)
    expect(p.meses).toBe('12')
    expect(p.anio).toBe(2025)
    expect(p.satPeriodicidad).toBe('04')
    // periodStart = 2025-12-01 00:00 MX = 2025-12-01T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2025-12-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-01-01 00:00 MX = 2026-01-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-01-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Feb 15 → closed period = Jan same year', () => {
    const now = mxNoon(2026, 2, 15)
    const p = closedPeriodFor('MENSUAL', now)
    expect(p.meses).toBe('01')
    expect(p.anio).toBe(2026)
  })
})

describe('closedPeriodFor — BIMESTRAL', () => {
  it('Jun 3 (May+Jun pair) → closed period = Mar+Apr 2026 (c_Meses=14)', () => {
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('BIMESTRAL', now)
    expect(p.meses).toBe('14') // Mar+Apr
    expect(p.anio).toBe(2026)
    expect(p.satPeriodicidad).toBe('05')
    expect(p.facturaPeriodicity).toBe('two_months')
    // periodStart = 2026-03-01 00:00 MX = 2026-03-01T06:00:00Z (permanently UTC-6)
    expect(p.periodStart.toISOString()).toBe(`2026-03-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-05-01 00:00 MX = 2026-05-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-05-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Jan 15 (Jan+Feb pair) → closed period = Nov+Dec 2025 (c_Meses=18)', () => {
    const now = mxNoon(2026, 1, 15)
    const p = closedPeriodFor('BIMESTRAL', now)
    expect(p.meses).toBe('18') // Nov+Dec
    expect(p.anio).toBe(2025)
    // periodStart = 2025-11-01 00:00 MX = 2025-11-01T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2025-11-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-01-01 00:00 MX = 2026-01-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-01-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Aug 1 (Jul+Aug pair) → closed period = May+Jun 2026 (c_Meses=15)', () => {
    const now = mxNoon(2026, 8, 1)
    const p = closedPeriodFor('BIMESTRAL', now)
    expect(p.meses).toBe('15') // May+Jun
    expect(p.anio).toBe(2026)
  })

  it('Dec 31 (Nov+Dec pair) → closed period = Sep+Oct same year (c_Meses=17)', () => {
    const now = mxNoon(2026, 12, 31)
    const p = closedPeriodFor('BIMESTRAL', now)
    expect(p.meses).toBe('17') // Sep+Oct
    expect(p.anio).toBe(2026)
  })
})

describe('closedPeriodFor — DIARIO', () => {
  it('Jun 3 → closed period = Jun 2 (yesterday)', () => {
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('DIARIO', now)
    expect(p.meses).toBe('06')
    expect(p.anio).toBe(2026)
    expect(p.satPeriodicidad).toBe('01')
    expect(p.facturaPeriodicity).toBe('day')
    // periodStart = 2026-06-02 00:00 MX = 2026-06-02T06:00:00Z (permanently UTC-6)
    expect(p.periodStart.toISOString()).toBe(`2026-06-02T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-06-03 00:00 MX = 2026-06-03T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-03T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Jan 1 → closed period = Dec 31 of previous year', () => {
    const now = mxNoon(2026, 1, 1)
    const p = closedPeriodFor('DIARIO', now)
    expect(p.meses).toBe('12')
    expect(p.anio).toBe(2025)
    // periodStart = 2025-12-31 00:00 MX (UTC-6) = 2025-12-31T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2025-12-31T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-01-01 00:00 MX (UTC-6) = 2026-01-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-01-01T${MX_MIDNIGHT_OFFSET}`)
  })
})

describe('closedPeriodFor — SEMANAL', () => {
  it('returns the previous Mon..Sun week (2026-06-03 is Wednesday)', () => {
    // 2026-06-03 is a Wednesday. Previous week = 2026-05-25(Mon)..2026-06-01(Mon exclusive)
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('SEMANAL', now)
    expect(p.satPeriodicidad).toBe('02')
    expect(p.facturaPeriodicity).toBe('week')
    // periodStart = 2026-05-25 00:00 MX (UTC-6) = 2026-05-25T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2026-05-25T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = 2026-06-01 00:00 MX (UTC-6) = 2026-06-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
    expect(p.meses).toBe('05') // May (month of the Mon that starts the closed week)
    expect(p.anio).toBe(2026)
  })

  it('on a Monday, closed week is the one that just ended Sunday', () => {
    // 2026-06-01 is a Monday. Previous week = 2026-05-25..2026-06-01
    const now = mxNoon(2026, 6, 1)
    const p = closedPeriodFor('SEMANAL', now)
    expect(p.periodStart.toISOString()).toBe(`2026-05-25T${MX_MIDNIGHT_OFFSET}`)
    expect(p.periodEnd.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
  })
})

describe('closedPeriodFor — QUINCENAL', () => {
  it('day 16+ → closed period is 1st fortnight of current month', () => {
    const now = mxNoon(2026, 6, 16)
    const p = closedPeriodFor('QUINCENAL', now)
    expect(p.satPeriodicidad).toBe('03')
    expect(p.facturaPeriodicity).toBe('fortnight')
    expect(p.meses).toBe('06')
    expect(p.anio).toBe(2026)
    // periodStart = Jun 1 00:00 MX = 2026-06-01T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = Jun 16 00:00 MX = 2026-06-16T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-16T${MX_MIDNIGHT_OFFSET}`)
  })

  it('day <=15 → closed period is 2nd fortnight of previous month', () => {
    const now = mxNoon(2026, 6, 3)
    const p = closedPeriodFor('QUINCENAL', now)
    expect(p.meses).toBe('05') // May
    expect(p.anio).toBe(2026)
    // periodStart = May 16 00:00 MX = 2026-05-16T06:00:00Z
    expect(p.periodStart.toISOString()).toBe(`2026-05-16T${MX_MIDNIGHT_OFFSET}`)
    // periodEnd = Jun 1 00:00 MX = 2026-06-01T06:00:00Z
    expect(p.periodEnd.toISOString()).toBe(`2026-06-01T${MX_MIDNIGHT_OFFSET}`)
  })

  it('Jan 10 → closed period is 2nd fortnight of Dec previous year', () => {
    const now = mxNoon(2026, 1, 10)
    const p = closedPeriodFor('QUINCENAL', now)
    expect(p.meses).toBe('12')
    expect(p.anio).toBe(2025)
  })
})

// ── C1 · Tarea 8: periodos recientes, inicio exacto, periodo de una fila vieja ─────────────────────────────────────────────
import {
  periodosCerradosRecientes,
  periodoQueEmpiezaEn,
  periodoRecienteQueEmpiezaEn,
  periodoDeGlobalPeriod,
  periodicidadDeCodigo,
  mismoPeriodo,
  PERIODOS_A_REVISAR,
  MOTIVO_PERIODO_VIEJO,
} from '../../../../src/services/fiscal/globalPeriod'

describe('C1 · periodos', () => {
  const ahora = new Date('2026-10-05T15:00:00Z')
  it.each(['DIARIO', 'SEMANAL', 'QUINCENAL', 'MENSUAL', 'BIMESTRAL'] as const)(
    '%s: contiguos, sin huecos ni encimados, el más reciente primero; y paginan',
    p => {
      const ps = periodosCerradosRecientes(p, ahora, 5)
      expect(ps).toHaveLength(5)
      expect(ps[0]).toEqual(closedPeriodFor(p, ahora))
      for (let i = 1; i < ps.length; i++) expect(ps[i].periodEnd.getTime()).toBe(ps[i - 1].periodStart.getTime())
      expect(periodosCerradosRecientes(p, ps[2].periodStart, 2)).toEqual(ps.slice(3, 5))
    },
  )
  it('sin `n`, revisa PERIODOS_A_REVISAR (C1-P8: 7/4/2/2/2)', () => {
    expect(PERIODOS_A_REVISAR).toEqual({ DIARIO: 7, SEMANAL: 4, QUINCENAL: 2, MENSUAL: 2, BIMESTRAL: 2 })
    for (const p of ['DIARIO', 'SEMANAL', 'QUINCENAL', 'MENSUAL', 'BIMESTRAL'] as const)
      expect(periodosCerradosRecientes(p, ahora)).toHaveLength(PERIODOS_A_REVISAR[p])
  })
  it('periodoQueEmpiezaEn (la usa el lector para validar un periodo guardado): un inicio exacto sí; una fecha que no es inicio, o un periodo abierto, no', () => {
    const treinta = periodosCerradosRecientes('DIARIO', ahora, 30)
    expect(treinta).toHaveLength(30) // rojo por aserción, no por `undefined`
    const viejo = treinta[29]
    expect(periodoQueEmpiezaEn('DIARIO', viejo.periodStart, ahora)).toEqual(viejo)
    expect(periodoQueEmpiezaEn('DIARIO', new Date(viejo.periodStart.getTime() + 3_600_000), ahora)).toBeNull()
    expect(periodoQueEmpiezaEn('DIARIO', closedPeriodFor('DIARIO', ahora).periodEnd, ahora)).toBeNull() // hoy no está cerrado
  })
  it.each(['SEMANAL', 'QUINCENAL', 'MENSUAL', 'BIMESTRAL'] as const)(
    'periodoQueEmpiezaEn %s: el inicio de un periodo de hace un año sí',
    p => {
      const treinta = periodosCerradosRecientes(p, ahora, 30)
      expect(treinta).toHaveLength(30)
      const viejo = treinta[29]
      expect(periodoQueEmpiezaEn(p, viejo.periodStart, ahora)).toEqual(viejo)
      expect(periodoQueEmpiezaEn(p, new Date(viejo.periodStart.getTime() + 86_400_000), ahora)).toBeNull()
    },
  )
  it('control — periodoQueEmpiezaEn: una fecha inválida no es ningún periodo', () => {
    expect(periodoQueEmpiezaEn('DIARIO', new Date('ayer'), ahora)).toBeNull()
  })
  it('🔴 C1-31 (C1-P16 = B): periodoRecienteQueEmpiezaEn sólo acepta los periodos que revisa el job; el 8.º diario hacia atrás, no', () => {
    const ps = periodosCerradosRecientes('DIARIO', ahora, 8)
    expect(ps).toHaveLength(8)
    expect(PERIODOS_A_REVISAR.DIARIO).toBe(7)
    expect(periodoRecienteQueEmpiezaEn('DIARIO', ps[6].periodStart, ahora)).toEqual(ps[6])
    expect(periodoRecienteQueEmpiezaEn('DIARIO', ps[7].periodStart, ahora)).toBeNull()
  })
  it.each(['SEMANAL', 'QUINCENAL', 'MENSUAL', 'BIMESTRAL'] as const)(
    '🔴 C1-31 %s: el último periodo de la ventana sí; el siguiente hacia atrás, a la mitad de un periodo o el de hoy (abierto), no',
    p => {
      const n = PERIODOS_A_REVISAR[p]
      const ps = periodosCerradosRecientes(p, ahora, n + 1)
      expect(ps).toHaveLength(n + 1)
      expect(periodoRecienteQueEmpiezaEn(p, ps[n - 1].periodStart, ahora)).toEqual(ps[n - 1])
      expect(periodoRecienteQueEmpiezaEn(p, ps[n].periodStart, ahora)).toBeNull()
      expect(periodoRecienteQueEmpiezaEn(p, new Date(ps[0].periodStart.getTime() + 1), ahora)).toBeNull()
      expect(periodoRecienteQueEmpiezaEn(p, ps[0].periodEnd, ahora)).toBeNull()
    },
  )
  it('control — el motivo del periodo viejo manda a soporte', () => {
    expect(MOTIVO_PERIODO_VIEJO).toMatch(/soporte/)
  })
  it('periodoDeGlobalPeriod: mensual y bimestral exactos; diario no se puede (sin día)', () => {
    expect(periodoDeGlobalPeriod({ periodicidad: '04', meses: '09', anio: 2026 })).toEqual(closedPeriodFor('MENSUAL', ahora))
    expect(periodoDeGlobalPeriod({ periodicidad: '05', meses: '17', anio: 2026 })).toEqual(
      closedPeriodFor('BIMESTRAL', new Date('2026-11-05T15:00:00Z')),
    )
    expect(periodoDeGlobalPeriod({ periodicidad: '01', meses: '10', anio: 2026 })).toBeNull()
  })
  it('periodoDeGlobalPeriod: los bordes de año (diciembre y noviembre-diciembre) y un código que no corresponde ⇒ null', () => {
    expect(periodoDeGlobalPeriod({ periodicidad: '04', meses: '12', anio: 2025 })).toEqual(
      closedPeriodFor('MENSUAL', new Date('2026-01-10T15:00:00Z')),
    )
    expect(periodoDeGlobalPeriod({ periodicidad: '05', meses: '18', anio: 2025 })).toEqual(
      closedPeriodFor('BIMESTRAL', new Date('2026-01-10T15:00:00Z')),
    )
    for (const gp of [
      { periodicidad: '04', meses: '13', anio: 2026 },
      { periodicidad: '04', meses: '00', anio: 2026 },
      { periodicidad: '04', meses: '9', anio: 2026 },
      { periodicidad: '05', meses: '09', anio: 2026 },
      { periodicidad: '05', meses: '19', anio: 2026 },
      { periodicidad: '04', meses: '09', anio: 2026.5 },
      { periodicidad: '02', meses: '10', anio: 2026 },
      { periodicidad: '03', meses: '10', anio: 2026 },
    ])
      expect([gp, periodoDeGlobalPeriod(gp)]).toEqual([gp, null])
  })
  it('periodicidadDeCodigo y mismoPeriodo', () => {
    expect(periodicidadDeCodigo('01')).toBe('DIARIO')
    expect(periodicidadDeCodigo('05')).toBe('BIMESTRAL')
    expect(periodicidadDeCodigo('99')).toBeNull()
    expect(periodicidadDeCodigo('toString')).toBeNull() // una llave heredada de Object no es un código
    const d = closedPeriodFor('DIARIO', ahora)
    expect(mismoPeriodo(d, { ...d })).toBe(true)
    expect(mismoPeriodo(d, closedPeriodFor('DIARIO', d.periodStart))).toBe(false)
    expect(mismoPeriodo(d, { ...d, satPeriodicidad: '02' })).toBe(false)
  })
})

// ── C1 · Tarea 9: la bimestral sólo con el régimen 621 (Guía del CFDI global, InformacionGlobal/Periodicidad) ──
import { motivoDePeriodicidad, satDePeriodicidad, MOTIVO_BIMESTRAL_SOLO_621 } from '../../../../src/services/fiscal/globalPeriod'

describe('C1 · bimestral sólo con régimen 621', () => {
  it('🔴 motivoDePeriodicidad mira la periodicidad del documento', () => {
    expect(motivoDePeriodicidad('05', '601')).toBe(MOTIVO_BIMESTRAL_SOLO_621)
    expect(motivoDePeriodicidad('05', '621')).toBeNull()
    expect(motivoDePeriodicidad('04', '601')).toBeNull()
  })
  it('🔴 con «05», cualquier régimen que no sea 621 lleva el motivo; con otro código, ninguno lo lleva (ni el 621)', () => {
    for (const regimen of ['601', '612', '626', '616', '62', '6210', ''])
      expect([regimen, motivoDePeriodicidad('05', regimen)]).toEqual([regimen, MOTIVO_BIMESTRAL_SOLO_621])
    for (const sat of ['01', '02', '03', '04'])
      for (const regimen of ['601', '621']) expect([sat, regimen, motivoDePeriodicidad(sat, regimen)]).toEqual([sat, regimen, null])
  })
  it.each([
    ['DIARIO', '01'],
    ['SEMANAL', '02'],
    ['QUINCENAL', '03'],
    ['MENSUAL', '04'],
    ['BIMESTRAL', '05'],
  ] as const)('🔴 satDePeriodicidad(%s) ⇒ %s (el mismo código que lleva el periodo cerrado)', (p, sat) => {
    expect(satDePeriodicidad(p)).toBe(sat)
    expect(closedPeriodFor(p, new Date('2026-11-05T15:00:00Z')).satPeriodicidad).toBe(sat)
  })
})

// ── C1 · Tarea 11 (Codex C1-33, C1-37): el año del periodo tiene que ser el de la emisión o el anterior, en hora de México ──
import { anioPermitido, MOTIVO_ANIO_FUERA } from '../../../../src/services/fiscal/globalPeriod'

describe('C1 · anioPermitido — el año de la emisión o el anterior (Guía del CFDI global, «Año»)', () => {
  it('🔴 el año en curso y el anterior sí; dos atrás o uno adelante, no', () => {
    const ahora = new Date('2026-10-05T15:00:00Z')
    expect([2027, 2026, 2025, 2024].map(a => anioPermitido(a, ahora))).toEqual([false, true, true, false])
  })
  it('🔴 el año se cuenta en hora de México: el 1-ene a las 05:59 UTC todavía es 31-dic', () => {
    expect(anioPermitido(2025, new Date('2027-01-01T05:59:59Z'))).toBe(true) // en México sigue siendo 2026
    expect(anioPermitido(2025, new Date('2027-01-01T06:00:00Z'))).toBe(false) // ya es 2027 en México
  })
  it('control — el motivo manda a soporte', () => {
    expect(MOTIVO_ANIO_FUERA).toMatch(/soporte/)
  })
})
