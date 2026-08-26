/**
 * Reporte de puntualidad — validar antes de consultar, tope inclusivo y ventana de pertenencia.
 * Auditoría Codex de la fase 2 del checador (2026-08-26), P2-2 y P2-4.
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
import { getAttendanceReport, MAX_REPORT_DAYS } from '@/services/dashboard/attendance.dashboard.service'

const db = prisma as any
const V = 'venue-1'
const weekly = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] }]),
)

function membership(over: Partial<{ id: string; staffId: string; startDate: Date; endDate: Date | null }> = {}) {
  return {
    id: 'sv-1',
    staffId: 'staff-1',
    startDate: new Date('2026-01-01T00:00:00Z'),
    endDate: null,
    staff: { firstName: 'Ana', lastName: 'López' },
    workSchedule: { weekly },
    workScheduleExceptions: [],
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  db.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City', settings: { attendanceGraceMinutes: 10 } })
  db.staffVenue.findMany.mockResolvedValue([membership()])
  db.timeEntry.findMany.mockResolvedValue([])
})

describe('P2-2 · validación antes de consultar', () => {
  it('rango invertido → 400 y NINGUNA consulta de personas ni de checadas', async () => {
    await expect(getAttendanceReport(V, '2026-08-26', '2026-08-20')).rejects.toThrow(/termina antes/)
    expect(db.staffVenue.findMany).not.toHaveBeenCalled()
    expect(db.timeEntry.findMany).not.toHaveBeenCalled()
  })

  it('rango absurdo (0001..9999) → 400 sin tocar la base', async () => {
    await expect(getAttendanceReport(V, '0001-01-01', '9999-12-31')).rejects.toThrow(/máximo/)
    expect(db.staffVenue.findMany).not.toHaveBeenCalled()
    expect(db.timeEntry.findMany).not.toHaveBeenCalled()
  })

  it(`el tope es INCLUSIVO: exactamente ${MAX_REPORT_DAYS} días pasan, ${MAX_REPORT_DAYS + 1} no`, async () => {
    // 1-ene .. 1-abr = 91 días (2026 no es bisiesto) → 92 fechas inclusive
    await expect(getAttendanceReport(V, '2026-01-01', '2026-04-02')).resolves.toBeDefined()
    await expect(getAttendanceReport(V, '2026-01-01', '2026-04-03')).rejects.toThrow(/máximo/)
  })
})

describe('P2-4 · ventana de pertenencia', () => {
  it('pide a quien estuvo en el equipo en el rango, no sólo a los activos hoy', async () => {
    await getAttendanceReport(V, '2026-08-01', '2026-08-05')
    const where = db.staffVenue.findMany.mock.calls[0][0].where
    expect(where).toEqual(
      expect.objectContaining({
        venueId: V,
        startDate: { lte: expect.any(Date) },
        OR: [{ active: true, endDate: null }, { endDate: { gte: expect.any(Date) } }],
      }),
    )
    expect(where).not.toHaveProperty('active')
  })

  it('quien entró el día 3 NO tiene faltas del 1 ni del 2', async () => {
    db.staffVenue.findMany.mockResolvedValue([membership({ startDate: new Date('2026-08-03T15:00:00Z') })])
    const { rows } = await getAttendanceReport(V, '2026-08-01', '2026-08-05')
    const dates = rows.map(r => r.date)
    expect(dates).not.toContain('2026-08-01')
    expect(dates).not.toContain('2026-08-02')
    expect(dates).toContain('2026-08-03')
  })

  it('quien se fue el día 3 sigue en la historia hasta el 3, y ya no después', async () => {
    db.staffVenue.findMany.mockResolvedValue([membership({ endDate: new Date('2026-08-03T20:00:00Z') })])
    const { rows } = await getAttendanceReport(V, '2026-08-01', '2026-08-05')
    const dates = rows.map(r => r.date)
    expect(dates).toEqual(expect.arrayContaining(['2026-08-01', '2026-08-02', '2026-08-03']))
    expect(dates).not.toContain('2026-08-04')
    expect(dates).not.toContain('2026-08-05')
  })

  it('regresión: sin cuadrante nadie es ABSENT, y los días pasados con cuadrante sin checada sí lo son', async () => {
    db.staffVenue.findMany.mockResolvedValue([membership({ id: 'sv-2', staffId: 'staff-2', workSchedule: null } as any), membership()])
    const { rows } = await getAttendanceReport(V, '2026-08-03', '2026-08-03')
    expect(rows.find(r => r.staffId === 'staff-2')).toBeUndefined()
    expect(rows.find(r => r.staffId === 'staff-1')?.status).toBe('ABSENT')
  })
})
