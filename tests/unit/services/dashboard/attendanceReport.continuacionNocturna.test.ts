/**
 * TURNO NOCTURNO: la continuación de la madrugada pertenece al turno de AYER.
 *
 * 🔴 Hallazgo P1 #4 de la 2ª auditoría de Codex (30-ago-2026), y es hermano del hueco entre
 * checadas: la rejilla sólo buscaba continuaciones en el cubo del día de la checada elegida
 * (`byStaffAndDay[pickedDate]`). En un turno 22:00→06:00 la segunda checada cae en el día
 * SIGUIENTE, así que no se veía nunca y sus minutos de extra se perdían enteros.
 *
 * Lo que hace difícil este caso —y por lo que el arreglo tiene un tope— es que el día
 * siguiente también tiene dueño: robarle su checada de la mañana a un turno diurno sería
 * peor que perder la extra. El tope es el MISMO que ya usa `pickEntryForDay`: sólo cuenta
 * lo que empieza antes de la hora de salida del turno nocturno.
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
const DIA = '2026-08-19' // miércoles: el turno nocturno arranca esta tarde
const SIGUIENTE = '2026-08-20'

const off = { enabled: false, ranges: [] }
/** 22:00 → 06:00: cierre antes que apertura ⇒ cruza la medianoche. */
const noche = { enabled: true, ranges: [{ open: '22:00', close: '06:00' }] }

const semanaNocturna = {
  monday: off,
  tuesday: off,
  wednesday: noche,
  thursday: off,
  friday: off,
  saturday: off,
  sunday: off,
}

const membership = {
  id: 'sv-1',
  staffId: 'staff-1',
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: null,
  staff: { firstName: 'Ana', lastName: 'Martínez' },
  workSchedule: { weekly: semanaNocturna },
  workScheduleExceptions: [],
}

/** Hora del NEGOCIO (México, UTC−6 en agosto). */
const mx = (dia: string, h: string, m = '00') => new Date(`${dia}T${h}:${m}:00.000-06:00`)

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

async function celdaDelMiercoles() {
  const { cells } = await buildAttendanceGrid(V, DIA, DIA)
  return cells.find(c => c.date === DIA)!
}

describe('la continuación de la MADRUGADA cuenta para el turno nocturno de ayer', () => {
  it('🔴 sale 02:00, vuelve 02:30, sale 07:30 → 90 min de extra, no 0', async () => {
    // Turno 22:00→06:00. Trabajó 22:00–02:00 y 02:30–07:30. Lo posterior a las 06:00 son
    // 90 minutos de hora extra — y vivían enteros en el cubo del día 20.
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx(DIA, '22'), mx(SIGUIENTE, '02')),
      checada(mx(SIGUIENTE, '02', '30'), mx(SIGUIENTE, '07', '30')),
    ])
    expect((await celdaDelMiercoles()).overtimeMinutes).toBe(90)
  })

  it('la última salida del reporte también es la de la continuación', async () => {
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx(DIA, '22'), mx(SIGUIENTE, '02')),
      checada(mx(SIGUIENTE, '02', '30'), mx(SIGUIENTE, '07', '30')),
    ])
    const celda = await celdaDelMiercoles()
    expect(celda.clockInTime).toEqual(mx(DIA, '22'))
    expect(celda.clockOutTime).toEqual(mx(SIGUIENTE, '07', '30'))
  })

  it('el hueco entre los dos tramos NO se paga', async () => {
    // 22:00–02:00 y 03:00–07:00: el hueco 02:00–03:00 es anterior al fin del turno, así que
    // no tocaría extra igual; lo que se comprueba es que 06:00–07:00 son 60 y no 120.
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx(DIA, '22'), mx(SIGUIENTE, '02')),
      checada(mx(SIGUIENTE, '03'), mx(SIGUIENTE, '07')),
    ])
    expect((await celdaDelMiercoles()).overtimeMinutes).toBe(60)
  })

  it('un descanso dentro de la continuación se descuenta de la extra', async () => {
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx(DIA, '22'), mx(SIGUIENTE, '02')),
      checada(mx(SIGUIENTE, '02', '30'), mx(SIGUIENTE, '07', '30'), [
        { startTime: mx(SIGUIENTE, '06', '30'), endTime: mx(SIGUIENTE, '06', '45') },
      ]),
    ])
    expect((await celdaDelMiercoles()).overtimeMinutes).toBe(75) // 90 − 15
  })

  it('🔴 NO se roba una checada que empieza DESPUÉS del fin del turno', async () => {
    // 08:00 del día siguiente está más allá de las 06:00: puede ser el turno de otro día.
    // Se queda fuera a propósito — el lado conservador es pagar de menos, no robar.
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx(DIA, '22'), mx(SIGUIENTE, '06')),
      checada(mx(SIGUIENTE, '08'), mx(SIGUIENTE, '12')),
    ])
    expect((await celdaDelMiercoles()).overtimeMinutes).toBe(0)
  })

  it('regresión: sin continuación, el turno nocturno sigue midiendo igual', async () => {
    db.timeEntry.findMany.mockResolvedValue([checada(mx(DIA, '22'), mx(SIGUIENTE, '07'))])
    expect((await celdaDelMiercoles()).overtimeMinutes).toBe(60)
  })
})

/**
 * 🔴 P1 #3 de la 3ª auditoría de Codex: el tope «empieza antes del fin del turno» NO alcanza
 * para decidir pertenencia. Si el día SIGUIENTE tiene su propio turno de madrugada, el
 * nocturno de ayer se comía su jornada entera.
 *
 * Reproducido antes de arreglarlo: el lunes reclamaba 420 minutos de extra que eran del martes,
 * y el martes se quedaba sin checada — o sea, como falta.
 */
describe('el nocturno NO le roba el turno al día siguiente', () => {
  const madrugada = { enabled: true, ranges: [{ open: '05:00', close: '13:00' }] }

  /** Lunes nocturno 22:00–06:00; martes con turno propio 05:00–13:00. */
  function conMartesQueMadruga() {
    db.staffVenue.findMany.mockResolvedValue([
      {
        ...membership,
        workSchedule: {
          weekly: { ...semanaNocturna, thursday: madrugada },
        },
      },
    ])
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx(DIA, '22'), mx(SIGUIENTE, '02')),
      checada(mx(SIGUIENTE, '05'), mx(SIGUIENTE, '13')),
    ])
  }

  it('🔴 el miércoles no reclama las horas del jueves', async () => {
    conMartesQueMadruga()
    expect((await celdaDelMiercoles()).overtimeMinutes).toBe(0)
  })

  it('🔴 y el jueves conserva su propia checada', async () => {
    conMartesQueMadruga()
    const { cells } = await buildAttendanceGrid(V, DIA, SIGUIENTE)
    const jueves = cells.find(c => c.date === SIGUIENTE)!
    expect(jueves.clockInTime).toEqual(mx(SIGUIENTE, '05'))
  })

  it('regresión: si el día siguiente NO trabaja, la continuación sí se recoge', async () => {
    // Es el caso que el arreglo anterior resolvió y que no se puede perder.
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx(DIA, '22'), mx(SIGUIENTE, '02')),
      checada(mx(SIGUIENTE, '02', '30'), mx(SIGUIENTE, '07', '30')),
    ])
    expect((await celdaDelMiercoles()).overtimeMinutes).toBe(90)
  })
})

/**
 * 🔴 P1 #1 de la 4ª auditoría de Codex: la atribución NO puede depender del rango consultado.
 *
 * El arreglo anterior preguntaba por el turno del día siguiente, pero la consulta sólo cargaba
 * cuadrantes y asignaciones hasta `endDate`. Con un turno ROTATIVO publicado el día siguiente,
 * pedir «sólo el miércoles» no lo traía y el miércoles se comía la jornada del jueves — mientras
 * que pedir «miércoles a jueves» la clasificaba bien. La misma semana, dos números distintos.
 */
describe('la atribución no depende del RANGO que se pida', () => {
  const rotativoDeMadrugada = [{ date: SIGUIENTE, startTime: '05:00', endTime: '13:00', status: 'PUBLISHED' }]

  function conTurnoRotativoElJueves() {
    db.venue.findUnique.mockResolvedValue({
      timezone: 'America/Mexico_City',
      settings: { attendanceGraceMinutes: 10, rotatingShiftsEnabled: true },
    })
    db.staffVenue.findMany.mockResolvedValue([{ ...membership, workShiftAssignments: rotativoDeMadrugada }])
    db.timeEntry.findMany.mockResolvedValue([
      checada(mx(DIA, '22'), mx(SIGUIENTE, '02')),
      checada(mx(SIGUIENTE, '05'), mx(SIGUIENTE, '13')),
    ])
  }

  /**
   * 🔴 Esta prueba mira la FORMA DE LA CONSULTA, no el resultado, y no es por comodidad: el
   * mock de Prisma devuelve un valor fijo IGNORANDO el `where`, así que una prueba sobre los
   * minutos pasa igual con la consulta rota. Se comprobó saboteándola — volver la ventana a
   * `endDate` no hacía fallar nada. Lo único que de verdad guarda el arreglo es exigir que se
   * consulte un día más.
   */
  it('🔴 los cuadrantes se consultan hasta el día SIGUIENTE al rango, no hasta el último', async () => {
    conTurnoRotativoElJueves()
    await buildAttendanceGrid(V, DIA, DIA)

    const select = db.staffVenue.findMany.mock.calls[0][0].select
    expect(select.workScheduleExceptions.where.startDate.lte).toBe(SIGUIENTE)
    expect(select.workShiftAssignments.where.date.lte).toBe(SIGUIENTE)
  })

  it('y las CELDAS siguen acotadas al rango pedido — el día extra sólo se consulta', async () => {
    conTurnoRotativoElJueves()
    const { cells } = await buildAttendanceGrid(V, DIA, DIA)
    expect(cells.every(c => c.date === DIA)).toBe(true)
  })

  it('el resultado es el mismo se pida el rango que se pida', async () => {
    conTurnoRotativoElJueves()
    const solo = await buildAttendanceGrid(V, DIA, DIA)
    conTurnoRotativoElJueves()
    const ambos = await buildAttendanceGrid(V, DIA, SIGUIENTE)
    expect(solo.cells.find(c => c.date === DIA)!.overtimeMinutes).toBe(
      ambos.cells.find(c => c.date === DIA)!.overtimeMinutes,
    )
  })
})

