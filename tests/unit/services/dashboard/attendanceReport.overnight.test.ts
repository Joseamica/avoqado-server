/**
 * Reporte — a qué DÍA pertenece una checada cuando el turno cruza la medianoche.
 *
 * Regla (documentada en el servicio): en un día con turno nocturno, cuenta la checada de la
 * TARDE de ese día (≥ 12:00) o, si no la hay, la de la MADRUGADA del día siguiente (< 12:00),
 * que es la llegada tarde después de medianoche. Una checada usada por un día no se reusa.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    timeEntry: { findMany: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { getAttendanceReport } from '@/services/dashboard/attendance.dashboard.service'

const db = prisma as any
const V = 'venue-1'
const off = { enabled: false, ranges: [] }
const night = { enabled: true, ranges: [{ open: '22:00', close: '06:00' }] }
// Semana pasada (19-20 ago 2026 = mié-jue), para que los días ya estén cerrados y se juzguen.
const weekly = { monday: off, tuesday: off, wednesday: night, thursday: night, friday: off, saturday: off, sunday: off }

const membership = {
  id: 'sv-1',
  staffId: 'staff-1',
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: null,
  staff: { firstName: 'Nico', lastName: 'Velador' },
  workSchedule: { weekly },
  workScheduleExceptions: [],
}
const entry = (iso: string, out?: string) => ({
  staffId: 'staff-1',
  clockInTime: new Date(iso),
  clockOutTime: out ? new Date(out) : null,
  validationStatus: null,
})

beforeEach(() => {
  jest.clearAllMocks()
  db.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City', settings: { attendanceGraceMinutes: 10 } })
  db.staffVenue.findMany.mockResolvedValue([membership])
  db.timeEntry.findMany.mockResolvedValue([])
})

const rowsFor = async (start: string, end: string) => (await getAttendanceReport(V, start, end)).rows

describe('atribución de checadas en turnos nocturnos', () => {
  it('la llegada del jueves 00:05 pertenece al turno del MIÉRCOLES: LATE 125, y el jueves queda ABSENT', async () => {
    db.timeEntry.findMany.mockResolvedValue([entry('2026-08-20T06:05:00.000Z')]) // jue 00:05 local
    const rows = await rowsFor('2026-08-19', '2026-08-20')
    const wed = rows.find(r => r.date === '2026-08-19')
    const thu = rows.find(r => r.date === '2026-08-20')
    expect(wed).toMatchObject({ status: 'LATE', lateMinutes: 125 })
    expect(thu?.status).toBe('ABSENT') // la misma checada NO se cuenta dos veces
  })

  it('madrugada del jueves + noche del jueves: cada checada a su turno', async () => {
    db.timeEntry.findMany.mockResolvedValue([
      entry('2026-08-20T06:05:00.000Z'), // jue 00:05 → turno del MIÉ
      entry('2026-08-21T04:30:00.000Z'), // jue 22:30 → turno del JUE
    ])
    const rows = await rowsFor('2026-08-19', '2026-08-20')
    expect(rows.find(r => r.date === '2026-08-19')).toMatchObject({ status: 'LATE', lateMinutes: 125 })
    expect(rows.find(r => r.date === '2026-08-20')).toMatchObject({ status: 'LATE', lateMinutes: 30 })
  })

  it('nocturno en el ÚLTIMO día del rango: la llegada de la madrugada siguiente igual cuenta', async () => {
    db.timeEntry.findMany.mockResolvedValue([entry('2026-08-20T06:10:00.000Z')]) // jue 00:10 local
    const rows = await rowsFor('2026-08-19', '2026-08-19')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ date: '2026-08-19', status: 'LATE', lateMinutes: 130 })
    // y la consulta de checadas tuvo que asomarse un día más allá del rango:
    const q = db.timeEntry.findMany.mock.calls[0][0].where.clockInTime
    expect(q.lte.getTime()).toBeGreaterThan(new Date('2026-08-20T05:59:59.000Z').getTime())
  })

  it('llegada puntual la noche del miércoles (22:05) se queda en el miércoles', async () => {
    db.timeEntry.findMany.mockResolvedValue([entry('2026-08-20T04:05:00.000Z', '2026-08-20T12:00:00.000Z')]) // mié 22:05 → jue 06:00
    const rows = await rowsFor('2026-08-19', '2026-08-19')
    expect(rows[0]).toMatchObject({ date: '2026-08-19', status: 'ON_TIME', lateMinutes: 5, earlyLeaveMinutes: 0 })
  })

  it('regresión: un día diurno normal no cambia (misma primera-entrada-del-día de siempre)', async () => {
    db.staffVenue.findMany.mockResolvedValue([
      { ...membership, workSchedule: { weekly: { ...weekly, wednesday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] } } } },
    ])
    db.timeEntry.findMany.mockResolvedValue([entry('2026-08-19T15:20:00.000Z')]) // mié 09:20 local
    const rows = await rowsFor('2026-08-19', '2026-08-19')
    expect(rows[0]).toMatchObject({ date: '2026-08-19', status: 'LATE', lateMinutes: 20 })
  })
})
