/**
 * Quién sale en Asistencia (Puntualidad, Nómina) — regla de dos pasos (founder, 20-oct-2026, Asana 1219720211947237):
 * con puesto vigente manda «Checa entrada y salida»; sin puesto, «Solo ver» (inversionistas) no sale y los demás sí.
 * Lo que alguien SÍ checó nunca se esconde: son horas que pueden pagarse.
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

import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { getAttendanceReport } from '@/services/dashboard/attendance.dashboard.service'
import { checaAsistencia, checaPorDefault } from '@/services/dashboard/rh/checaAsistencia'

const db = prisma as any
const V = 'venue-1'
// Con horario, para que quien sí sale tenga renglón aunque no haya checado (sin horario ni checadas no hay nada que juzgar).
const weekly = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [
    d,
    { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
  ]),
)

function persona(staffId: string, role: StaffRole, puestos: Array<{ tracksAttendance: boolean }>) {
  return {
    id: `sv-${staffId}`,
    staffId,
    role,
    startDate: new Date('2026-01-01T00:00:00Z'),
    endDate: null,
    staff: { firstName: staffId, lastName: 'X', staffAssignments: puestos },
    workSchedule: { weekly },
    workScheduleExceptions: [],
  }
}

describe('checaAsistencia', () => {
  it('con puesto manda el switch, aunque el rol sea «Solo ver»', () => {
    expect(checaAsistencia(StaffRole.VIEWER, [{ tracksAttendance: true }])).toBe(true)
    expect(checaAsistencia(StaffRole.WAITER, [{ tracksAttendance: false }])).toBe(false)
  })
  it('con dos puestos basta uno que cheque', () => {
    expect(checaAsistencia(StaffRole.WAITER, [{ tracksAttendance: false }, { tracksAttendance: true }])).toBe(true)
  })
  it('sin puesto: «Solo ver» no checa, los demás sí', () => {
    expect(checaAsistencia(StaffRole.VIEWER, [])).toBe(false)
    expect(checaAsistencia(StaffRole.WAITER, [])).toBe(true)
    expect(checaAsistencia(StaffRole.OWNER, [])).toBe(true)
  })
  it('un puesto de «Solo ver» nace sin checar', () => {
    expect(checaPorDefault(StaffRole.VIEWER)).toBe(false)
    expect(checaPorDefault(StaffRole.KITCHEN)).toBe(true)
  })
})

describe('reporte de asistencia', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    db.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City', settings: { attendanceGraceMinutes: 10 } })
    db.timeEntry.findMany.mockResolvedValue([])
  })

  it('pide sólo los puestos vigentes de ESTA sede', async () => {
    db.staffVenue.findMany.mockResolvedValue([])
    await getAttendanceReport(V, '2026-08-03', '2026-08-03')
    const sel = db.staffVenue.findMany.mock.calls[0][0].select
    expect(sel.role).toBe(true)
    expect(sel.staff.select.staffAssignments.where).toEqual(
      expect.objectContaining({ venueId: V, effectiveFrom: { lte: expect.any(Date) } }),
    )
  })

  it('el inversionista sin checadas no sale; el mesero sí', async () => {
    db.staffVenue.findMany.mockResolvedValue([
      persona('inversionista', StaffRole.VIEWER, [{ tracksAttendance: false }]),
      persona('socio-sin-puesto', StaffRole.VIEWER, []),
      persona('mesero', StaffRole.WAITER, [{ tracksAttendance: true }]),
    ])
    const { rows } = await getAttendanceReport(V, '2026-08-03', '2026-08-03')
    expect([...new Set(rows.map(r => r.staffId))]).toEqual(['mesero'])
  })

  it('si alguien que «no checa» SÍ checó, sale con sus horas', async () => {
    db.staffVenue.findMany.mockResolvedValue([persona('inversionista', StaffRole.VIEWER, [{ tracksAttendance: false }])])
    db.timeEntry.findMany.mockResolvedValue([
      {
        staffId: 'inversionista',
        clockInTime: new Date('2026-08-03T15:00:00Z'),
        clockOutTime: new Date('2026-08-03T20:00:00Z'),
        validationStatus: 'PENDING',
        totalHours: 5,
        breakMinutes: 0,
        breaks: [],
      },
    ])
    const { rows } = await getAttendanceReport(V, '2026-08-03', '2026-08-03')
    expect(rows.map(r => r.staffId)).toEqual(['inversionista'])
  })
})
