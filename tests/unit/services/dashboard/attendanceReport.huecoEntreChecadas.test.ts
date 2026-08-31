/**
 * La REJILLA junta los tramos reales trabajados — no sólo la primera entrada y la última salida.
 *
 * 🔴 Este archivo existe por un hueco que destapó un sabotaje a propósito: la función pura ya
 * estaba bien probada (19 casos), pero **quitar la recolección de tramos en la rejilla no
 * rompía NADA**. El cableado no tenía guardia; sólo lo había verificado a mano contra la base.
 *
 * El defecto que guarda es el #1 de la auditoría de Codex, el más caro: alguien sale a las
 * 17:00, se va a su casa, vuelve a las 18:00 y sale a las 19:00 — la rejilla colapsaba eso a
 * «09:00 → 19:00» y se pagaban 2 h cuando trabajó 1. El hueco entre dos `TimeEntry` NO es un
 * `TimeEntryBreak`, así que nadie lo descontaba.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    timeEntry: { findMany: jest.fn() },
    overtimeApproval: { findMany: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { buildAttendanceGrid } from '@/services/dashboard/attendance.dashboard.service'

const db = prisma as any
const V = 'venue-1'
const DIA = '2026-08-19' // miércoles ya cerrado
const off = { enabled: false, ranges: [] }
const dia = { enabled: true, ranges: [{ open: '09:00', close: '17:00' }] }
const weekly = { monday: off, tuesday: off, wednesday: dia, thursday: off, friday: off, saturday: off, sunday: off }

const membership = {
  id: 'sv-1',
  staffId: 'staff-1',
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: null,
  staff: { firstName: 'Ana', lastName: 'Martínez' },
  workSchedule: { weekly },
  workScheduleExceptions: [],
}

/** Hora del NEGOCIO (México, UTC−6 en agosto). */
const mx = (h: string, m = '00') => new Date(`${DIA}T${h}:${m}:00.000-06:00`)

const checada = (entra: Date, sale: Date | null, breaks: any[] = []) => ({
  staffId: 'staff-1',
  clockInTime: entra,
  clockOutTime: sale,
  validationStatus: null,
  totalHours: 0,
  breakMinutes: 0,
  breaks,
})

beforeEach(() => {
  jest.clearAllMocks()
  db.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City', settings: { attendanceGraceMinutes: 10 } })
  db.staffVenue.findMany.mockResolvedValue([membership])
  db.timeEntry.findMany.mockResolvedValue([])
  db.overtimeApproval.findMany.mockResolvedValue([])
})

async function extraDelDia(): Promise<number> {
  const { cells } = await buildAttendanceGrid(V, DIA, DIA)
  return cells.find(c => c.date === DIA)?.overtimeMinutes ?? -1
}

describe('la rejilla NO paga el hueco entre dos checadas', () => {
  it('🔴 sale 17:00, vuelve 18:00, sale 19:00 → 60 min, no 120', async () => {
    db.timeEntry.findMany.mockResolvedValue([checada(mx('09'), mx('17')), checada(mx('18'), mx('19'))])
    expect(await extraDelDia()).toBe(60)
  })

  it('🔴 tres tramos con dos huecos cuentan sólo lo trabajado', async () => {
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx('09'), mx('17')),
      checada(mx('17', '30'), mx('18')), // 30
      checada(mx('19'), mx('19', '45')), // 45
    ])
    expect(await extraDelDia()).toBe(75)
  })

  it('regresión: UNA sola checada larga sigue dando lo mismo que antes', async () => {
    db.timeEntry.findMany.mockResolvedValue([checada(mx('09'), mx('19'))])
    expect(await extraDelDia()).toBe(120)
  })

  it('la primera entrada y la última salida siguen siendo las del reporte', async () => {
    // El hueco cambia la hora EXTRA, no lo que la pantalla enseña como entrada y salida:
    // el evaluador de retardos depende de esos dos campos.
    db.timeEntry.findMany.mockResolvedValue([checada(mx('09'), mx('17')), checada(mx('18'), mx('19'))])
    const { cells } = await buildAttendanceGrid(V, DIA, DIA)
    const celda = cells.find(c => c.date === DIA)!
    expect(celda.clockInTime).toEqual(mx('09'))
    expect(celda.clockOutTime).toEqual(mx('19'))
  })

  it('un descanso dentro del SEGUNDO tramo también se descuenta', async () => {
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx('09'), mx('17')),
      checada(mx('18'), mx('19'), [{ startTime: mx('18', '15'), endTime: mx('18', '30') }]),
    ])
    expect(await extraDelDia()).toBe(45) // 60 trabajados − 15 de descanso
  })

  it('una segunda checada ABIERTA no aporta ni rompe la primera', async () => {
    db.timeEntry.findMany.mockResolvedValue([checada(mx('09'), mx('19')), checada(mx('20'), null)])
    expect(await extraDelDia()).toBe(120)
  })
})
