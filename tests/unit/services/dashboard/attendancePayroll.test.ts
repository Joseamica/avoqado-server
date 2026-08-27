/**
 * Fase 3 — el puente a nómina: un resumen por persona del periodo con los números que una
 * nómina necesita, salidos de la MISMA rejilla que el reporte de puntualidad (una sola verdad).
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    timeEntry: { findMany: jest.fn(), groupBy: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import prisma from '@/utils/prismaClient'
import { getPayrollSummary } from '@/services/dashboard/attendancePayroll.service'

const db = prisma as any
const off = { enabled: false, ranges: [] }
const day9to6 = { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] }
// Semana pasada completa (17–21 ago 2026 = lun–vie), ya cerrada: todo se juzga.
const weekly = { monday: day9to6, tuesday: day9to6, wednesday: day9to6, thursday: day9to6, friday: day9to6, saturday: off, sunday: off }

const membership = (over: Record<string, unknown> = {}) => ({
  id: 'sv-1',
  staffId: 'staff-1',
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: null,
  staff: { firstName: 'Ana', lastName: 'López' },
  workSchedule: { weekly },
  workScheduleExceptions: [],
  ...over,
})
const entry = (iso: string, out?: string) => ({
  staffId: 'staff-1',
  clockInTime: new Date(iso),
  clockOutTime: out ? new Date(out) : null,
  validationStatus: null,
})

beforeEach(() => {
  jest.clearAllMocks()
  db.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City', settings: { attendanceGraceMinutes: 10 } })
  db.staffVenue.findMany.mockResolvedValue([membership()])
  db.timeEntry.findMany.mockResolvedValue([])
  db.timeEntry.groupBy.mockResolvedValue([])
})

const run = () => getPayrollSummary('venue-1', '2026-08-17', '2026-08-21')

describe('getPayrollSummary', () => {
  it('semana con 3 asistencias (1 tarde), 1 vacación y 1 falta: los números que van a la nómina', async () => {
    db.staffVenue.findMany.mockResolvedValue([
      membership({
        workScheduleExceptions: [
          { startDate: '2026-08-20', endDate: '2026-08-20', kind: 'OFF', type: 'VACATION', startTime: null, endTime: null },
        ],
      }),
    ])
    db.timeEntry.findMany.mockResolvedValue([
      entry('2026-08-17T14:55:00.000Z'), // lun 08:55 a tiempo
      entry('2026-08-18T15:30:00.000Z'), // mar 09:30 → 30 tarde
      entry('2026-08-19T15:05:00.000Z'), // mié 09:05 dentro de tolerancia
      // jue = vacación · vie = sin checada → FALTA
    ])
    db.timeEntry.groupBy.mockResolvedValue([{ staffId: 'staff-1', _sum: { totalHours: 25.5, breakMinutes: 90 } }])

    const { rows } = await run()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      expect.objectContaining({
        staffId: 'staff-1',
        name: 'Ana López',
        scheduledDays: 4, // la vacación NO cuenta como día exigible
        workedDays: 3,
        lateDays: 1,
        lateMinutesTotal: 30,
        absentDays: 1,
        hoursWorked: 25.5,
        breakMinutes: 90,
      }),
    )
    expect(rows[0].absences).toEqual({ VACATION: 1 })
  })

  it('la vacación NUNCA aparece como falta (ese es el punto de la fase 3)', async () => {
    db.staffVenue.findMany.mockResolvedValue([
      membership({
        workScheduleExceptions: [
          { startDate: '2026-08-17', endDate: '2026-08-21', kind: 'OFF', type: 'VACATION', startTime: null, endTime: null },
        ],
      }),
    ])
    const { rows } = await run()
    expect(rows[0].absentDays).toBe(0)
    expect(rows[0].absences).toEqual({ VACATION: 5 })
  })

  it('el descanso semanal no es ausencia: no aparece en el desglose por tipo', async () => {
    const { rows } = await run()
    expect(rows[0].absences).toEqual({})
    expect(rows[0].scheduledDays).toBe(5)
    expect(rows[0].absentDays).toBe(5) // semana cerrada sin una sola checada
  })

  it('permiso sin goce y falta justificada cuentan por separado', async () => {
    db.staffVenue.findMany.mockResolvedValue([
      membership({
        workScheduleExceptions: [
          { startDate: '2026-08-17', endDate: '2026-08-17', kind: 'OFF', type: 'UNPAID_LEAVE', startTime: null, endTime: null },
          { startDate: '2026-08-18', endDate: '2026-08-18', kind: 'OFF', type: 'JUSTIFIED_ABSENCE', startTime: null, endTime: null },
        ],
      }),
    ])
    const { rows } = await run()
    expect(rows[0].absences).toEqual({ UNPAID_LEAVE: 1, JUSTIFIED_ABSENCE: 1 })
    expect(rows[0].scheduledDays).toBe(3)
  })

  it('la rejilla PIDE el tipo de la excepción a la base (un mock lo pasa gratis; el select real no)', async () => {
    await run()
    const select = db.staffVenue.findMany.mock.calls[0][0].select.workScheduleExceptions.select
    expect(select).toEqual(expect.objectContaining({ type: true }))
  })

  it('las horas EXCLUYEN checadas rechazadas por el gerente', async () => {
    await run()
    const where = db.timeEntry.groupBy.mock.calls[0][0].where
    expect(JSON.stringify(where)).toMatch(/REJECTED/)
  })

  it('sin cuadrante: nada exigible, nada de faltas — pero las horas trabajadas SÍ se reportan', async () => {
    db.staffVenue.findMany.mockResolvedValue([membership({ workSchedule: null })])
    db.timeEntry.groupBy.mockResolvedValue([{ staffId: 'staff-1', _sum: { totalHours: 12, breakMinutes: 0 } }])
    const { rows } = await run()
    expect(rows[0]).toEqual(expect.objectContaining({ scheduledDays: 0, absentDays: 0, hoursWorked: 12 }))
  })

  it('regresión: hereda las validaciones del reporte (rango invertido no consulta nada)', async () => {
    await expect(getPayrollSummary('venue-1', '2026-08-21', '2026-08-17')).rejects.toThrow(/termina antes/)
    expect(db.staffVenue.findMany).not.toHaveBeenCalled()
  })
})
