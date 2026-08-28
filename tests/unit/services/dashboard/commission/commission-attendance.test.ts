/**
 * Asistencia → comisiones (decisión del founder, 2026-08-26): una regla POR ESQUEMA, apagada
 * de fábrica, que castiga con un porcentaje la comisión del día en que la persona llegó TARDE.
 *
 * Principios que fija esta suite (dinero ⇒ prueba primero):
 * - Apagada ⇒ null SIN tocar la base: un esquema de hoy produce mañana exactamente lo mismo.
 * - Sólo castiga RETARDO fuera de tolerancia. Falta no genera ventas (no hay qué descontar);
 *   sin cuadrante, día libre o dentro de tolerancia ⇒ comisión completa.
 * - Venue con asistencia APAGADA ⇒ regla inerte (no puede haber "no stopper" más literal).
 * - FALLA ABIERTA: si evaluar la asistencia truena, la comisión se paga completa. El dinero
 *   nunca se cae por culpa del checador.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    timeEntry: { findMany: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { resolveAttendancePenaltyRate } from '@/services/dashboard/commission/commission-attendance'

const db = prisma as any
const TZ = 'America/Mexico_City' // UTC-6 en agosto
const weekly = { wednesday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] } }
const AT = new Date('2026-08-26T20:30:00.000Z') // mié 14:30 local

const base = { staffId: 'staff-1', venueId: 'venue-1', at: AT }
const linked = (rate: number | null = 0.25) => ({ attendanceLinked: true, attendanceLatePenaltyRate: rate })

function primeHappyPath(clockInIso: string | null, over: Record<string, unknown> = {}) {
  db.venue.findUnique.mockResolvedValue({
    timezone: TZ,
    settings: { attendanceEnabled: true, attendanceGraceMinutes: 10 },
    ...over,
  })
  db.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', workSchedule: { weekly }, workScheduleExceptions: [] })
  db.timeEntry.findMany.mockResolvedValue(clockInIso ? [{ clockInTime: new Date(clockInIso) }] : [])
}

beforeEach(() => jest.clearAllMocks())

describe('resolveAttendancePenaltyRate', () => {
  it('regla APAGADA → null y CERO consultas (el default de hoy no cambia para nadie)', async () => {
    const r = await resolveAttendancePenaltyRate({ config: { attendanceLinked: false, attendanceLatePenaltyRate: 0.25 }, ...base })
    expect(r).toBeNull()
    expect(db.venue.findUnique).not.toHaveBeenCalled()
  })

  it('prendida sin porcentaje (o 0) → null sin consultas: no hay castigo que aplicar', async () => {
    expect(await resolveAttendancePenaltyRate({ config: linked(null), ...base })).toBeNull()
    expect(await resolveAttendancePenaltyRate({ config: linked(0), ...base })).toBeNull()
    expect(db.venue.findUnique).not.toHaveBeenCalled()
  })

  it('llegó TARDE fuera de tolerancia (09:25, gracia 10) → devuelve el porcentaje del esquema', async () => {
    primeHappyPath('2026-08-26T15:25:00.000Z') // mié 09:25 local
    expect(await resolveAttendancePenaltyRate({ config: linked(0.25), ...base })).toBe(0.25)
  })

  it('a tiempo (08:55) y dentro de tolerancia (09:08) → null', async () => {
    primeHappyPath('2026-08-26T14:55:00.000Z')
    expect(await resolveAttendancePenaltyRate({ config: linked(), ...base })).toBeNull()
    primeHappyPath('2026-08-26T15:08:00.000Z')
    expect(await resolveAttendancePenaltyRate({ config: linked(), ...base })).toBeNull()
  })

  it('sin cuadrante → null: nadie está obligado a llenar horarios para cobrar comisiones', async () => {
    primeHappyPath('2026-08-26T15:25:00.000Z')
    db.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', workSchedule: null, workScheduleExceptions: [] })
    expect(await resolveAttendancePenaltyRate({ config: linked(), ...base })).toBeNull()
  })

  it('día libre (excepción OFF) → null aunque haya checado tarde', async () => {
    primeHappyPath('2026-08-26T15:25:00.000Z')
    db.staffVenue.findFirst.mockResolvedValue({
      id: 'sv-1',
      workSchedule: { weekly },
      workScheduleExceptions: [{ startDate: '2026-08-26', endDate: '2026-08-26', kind: 'OFF', startTime: null, endTime: null }],
    })
    expect(await resolveAttendancePenaltyRate({ config: linked(), ...base })).toBeNull()
  })

  it('sin checada del día (falta) → null: una falta no genera ventas, no hay qué descontar', async () => {
    primeHappyPath(null)
    expect(await resolveAttendancePenaltyRate({ config: linked(), ...base })).toBeNull()
  })

  it('venue con asistencia APAGADA → null y no se consulta ni el cuadrante ni la checada', async () => {
    db.venue.findUnique.mockResolvedValue({ timezone: TZ, settings: { attendanceEnabled: false, attendanceGraceMinutes: 10 } })
    expect(await resolveAttendancePenaltyRate({ config: linked(), ...base })).toBeNull()
    expect(db.staffVenue.findFirst).not.toHaveBeenCalled()
    expect(db.timeEntry.findMany).not.toHaveBeenCalled()
  })

  it('FALLA ABIERTA: si la base truena, null y sin excepción — la comisión se paga completa', async () => {
    db.venue.findUnique.mockRejectedValue(new Error('boom'))
    await expect(resolveAttendancePenaltyRate({ config: linked(), ...base })).resolves.toBeNull()
  })

  it('la checada RECHAZADA por el gerente no cuenta: el filtro excluye REJECTED', async () => {
    primeHappyPath('2026-08-26T15:25:00.000Z')
    await resolveAttendancePenaltyRate({ config: linked(), ...base })
    const where = db.timeEntry.findMany.mock.calls[0][0].where
    expect(JSON.stringify(where)).toMatch(/REJECTED/)
  })

  it('acepta el Decimal de Prisma como porcentaje', async () => {
    primeHappyPath('2026-08-26T15:25:00.000Z')
    const decimalish = { toString: () => '0.5000' }
    expect(
      await resolveAttendancePenaltyRate({ config: { attendanceLinked: true, attendanceLatePenaltyRate: decimalish as any }, ...base }),
    ).toBe(0.5)
  })
})

describe('applyAttendancePenalty (puro)', () => {
  const { applyAttendancePenalty } = jest.requireActual('@/services/dashboard/commission/commission-attendance')
  it('recorta y redondea a centavos', () => {
    expect(applyAttendancePenalty(100, 0.25)).toBe(75)
    expect(applyAttendancePenalty(10.01, 0.5)).toBe(5.01)
    expect(applyAttendancePenalty(33.33, 0.1)).toBe(30)
  })
  it('sin castigo devuelve el monto intacto', () => {
    expect(applyAttendancePenalty(100, null)).toBe(100)
    expect(applyAttendancePenalty(100, 0)).toBe(100)
  })
})

// ─── Turno NOCTURNO: misma atribución que el reporte de asistencia (Codex 27-ago: divergían) ───
describe('turno nocturno (22:00–06:00) — la venta de madrugada pertenece al turno de AYER', () => {
  const nightWeekly = { wednesday: { enabled: true, ranges: [{ open: '22:00', close: '06:00' }] } }
  const SALE_THU_0100 = new Date('2026-08-27T07:00:00.000Z') // jue 01:00 local
  function primeNight(entries: string[]) {
    db.venue.findUnique.mockResolvedValue({ timezone: TZ, settings: { attendanceEnabled: true, attendanceGraceMinutes: 10 } })
    db.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', workSchedule: { weekly: nightWeekly }, workScheduleExceptions: [] })
    db.timeEntry.findMany.mockResolvedValue(entries.map(iso => ({ clockInTime: new Date(iso) })))
  }
  it('🔴 checó el miércoles 22:25 (25 min tarde) y vendió el jueves 01:00 → se castiga contra el turno del MIÉRCOLES', async () => {
    primeNight(['2026-08-27T04:25:00.000Z']) // mié 22:25 local
    expect(await resolveAttendancePenaltyRate({ config: linked(0.25), ...base, at: SALE_THU_0100 })).toBe(0.25)
  })
  it('checó el miércoles 21:55 → a tiempo → null', async () => {
    primeNight(['2026-08-27T03:55:00.000Z'])
    expect(await resolveAttendancePenaltyRate({ config: linked(0.25), ...base, at: SALE_THU_0100 })).toBeNull()
  })
  it('🔴 sin checada de la tarde, cuenta la de la MADRUGADA siguiente antes de la salida (jue 00:05 = 2h05 tarde)', async () => {
    primeNight(['2026-08-27T06:05:00.000Z']) // jue 00:05 local
    expect(await resolveAttendancePenaltyRate({ config: linked(0.25), ...base, at: SALE_THU_0100 })).toBe(0.25)
  })
})

// ─── Turnos ROTATIVOS (fase 1 "como Sesame"): la asignación PUBLICADA manda si el venue los prendió ───
describe('turno rotativo asignado', () => {
  function primeRotating(enabled: boolean, clockInIso: string, status = 'PUBLISHED') {
    db.venue.findUnique.mockResolvedValue({ timezone: TZ, settings: { attendanceEnabled: true, attendanceGraceMinutes: 10, rotatingShiftsEnabled: enabled } })
    db.staffVenue.findFirst.mockResolvedValue({
      id: 'sv-1',
      workSchedule: { weekly },
      workScheduleExceptions: [],
      workShiftAssignments: enabled ? [{ date: '2026-08-26', startTime: '11:00', endTime: '19:00', status }] : undefined,
    })
    db.timeEntry.findMany.mockResolvedValue([{ clockInTime: new Date(clockInIso) }])
  }
  it('🔴 con turnos prendidos, "Cierre 11–19" gana a la jornada fija 09–18: checar 09:25 NO es retardo', async () => {
    primeRotating(true, '2026-08-26T15:25:00.000Z') // 09:25 local
    expect(await resolveAttendancePenaltyRate({ config: linked(0.25), ...base })).toBeNull()
  })
  it('… y checar 11:25 SÍ lo es', async () => {
    primeRotating(true, '2026-08-26T17:25:00.000Z') // 11:25 local
    expect(await resolveAttendancePenaltyRate({ config: linked(0.25), ...base })).toBe(0.25)
  })
  it('🔴 con el interruptor APAGADO la asignación se ignora y manda la jornada fija (09:25 = retardo)', async () => {
    primeRotating(false, '2026-08-26T15:25:00.000Z')
    expect(await resolveAttendancePenaltyRate({ config: linked(0.25), ...base })).toBe(0.25)
    // y ni siquiera se piden las asignaciones
    expect(db.staffVenue.findFirst.mock.calls[0][0].select.workShiftAssignments).toBeUndefined()
  })
})
