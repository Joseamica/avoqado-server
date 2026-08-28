/**
 * Asistencia — lectura y validación de checadas desde el dashboard del negocio.
 *
 * El motor del checador ya existe y lo consumen la TPV, Android e iOS
 * (`services/tpv/time-entry.tpv.service.ts`): marcar entrada y salida con PIN, los
 * descansos, la foto y el GPS. Este servicio NO reimplementa nada de eso — solo abre
 * la lectura y la aprobación al dueño de un negocio normal, que hasta ahora únicamente
 * existían en el panel de organización, detrás del acceso white-label.
 *
 * Lo único que aporta es el acotamiento por venue. Las funciones que se reusan reciben
 * `staffId` / `timeEntryId` sueltos porque nacieron dentro de una sesión de terminal ya
 * atada a su venue; expuestas por HTTP, ese id llega del cliente y hay que comprobarlo.
 */
import { DateTime } from 'luxon'

import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { getCurrentlyClockedInStaff, getTimeEntries } from '../tpv/time-entry.tpv.service'
import { evaluateAttendance, type AttendanceStatus } from './attendanceEvaluator'
import { type ExpectedDay, resolveExpectedDay, type WeeklyWorkSchedule, type WorkScheduleException } from './workSchedule.service'
import type { TimeEntryStatus } from '@prisma/client'

export interface VenueTimeEntriesQuery {
  staffId?: string
  startDate?: string
  endDate?: string
  status?: TimeEntryStatus
  limit?: number
  offset?: number
}

/** Checadas del negocio. `getTimeEntries` ya filtra por venueId, así que basta con pasarlo. */
export async function getVenueTimeEntries(venueId: string, query: VenueTimeEntriesQuery = {}) {
  // El motor TPV hace `new Date(startDate)` — medianoche UTC, no del negocio. Se le pasan
  // instantes ya resueltos en la zona del venue para que el día final entre completo.
  const { from, to } = await venueDateRange(venueId, query.startDate, query.endDate)
  return getTimeEntries({
    venueId,
    ...query,
    startDate: from?.toISOString(),
    endDate: to?.toISOString(),
  })
}

/** Quién está dentro en este momento. Ya viene acotado al venue. */
export async function getVenueActiveStaff(venueId: string) {
  return getCurrentlyClockedInStaff(venueId)
}

/**
 * Horas de una persona en un rango.
 *
 * `getStaffTimeSummary` recibe sólo `staffId`, sin venue: sin esta comprobación previa,
 * un negocio podría pedir el resumen de un empleado de otro negocio pasando su id.
 */
export async function getVenueStaffTimeSummary(venueId: string, staffId: string, startDate: string, endDate: string) {
  const membership = await prisma.staffVenue.findFirst({
    where: { staffId, venueId },
    select: { id: true },
  })

  if (!membership) {
    throw new NotFoundError('Ese empleado no pertenece a este negocio')
  }

  // 🔴 NO se delega a `getStaffTimeSummary`: esa función filtra sólo por staffId y sumaba las
  // horas de TODOS los negocios donde trabaja la persona (auditoría Codex 2026-08-26, P1).
  // Aquí se acota a este venue y se interpreta el rango en SU zona horaria.
  const { from, to } = await venueDateRange(venueId, startDate, endDate)
  const entries = await prisma.timeEntry.findMany({
    where: { staffId, venueId, clockInTime: { gte: from, lte: to } },
    select: { totalHours: true, breakMinutes: true },
  })

  const totalHours = entries.reduce((sum, e) => sum + Number(e.totalHours ?? 0), 0)
  const totalBreakMinutes = entries.reduce((sum, e) => sum + (e.breakMinutes ?? 0), 0)
  return {
    staffId,
    venueId,
    period: { startDate, endDate },
    totalHours: Number(totalHours.toFixed(2)),
    totalBreakMinutes,
    totalShifts: entries.length,
    averageHoursPerShift: entries.length ? Number((totalHours / entries.length).toFixed(2)) : 0,
  }
}

/**
 * Convierte un rango 'YYYY-MM-DD' (fecha del NEGOCIO) en dos instantes UTC que cubren esos
 * días completos EN LA ZONA DEL VENUE. `new Date('2026-08-20')` es medianoche UTC — en México,
 * el 19 a las 18:00 — y dejaba fuera casi todo el día final (auditoría Codex, P1).
 */
async function venueDateRange(venueId: string, startDate?: string, endDate?: string) {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone || 'America/Mexico_City'
  return {
    from: startDate ? DateTime.fromISO(startDate, { zone: tz }).startOf('day').toJSDate() : undefined,
    to: endDate ? DateTime.fromISO(endDate, { zone: tz }).endOf('day').toJSDate() : undefined,
  }
}

/**
 * Reporte de puntualidad: junta el cuadrante con lo que realmente pasó.
 *
 * 🔴 Todo se resuelve en la zona del NEGOCIO. El cuadrante dice "9:00" en hora local y las
 * checadas se guardan en UTC; compararlas crudas hace que en México todo el mundo llegue
 * seis horas tarde.
 *
 * A quien NO tiene cuadrante no se le juzga (`NO_SCHEDULE`), nunca se le marca falta: un
 * negocio que aún no armó sus horarios no debe abrir la pantalla y ver a todo su personal
 * en rojo.
 */
export interface AttendanceReportRow {
  staffId: string
  staffVenueId: string
  name: string
  date: string
  expectedStart: string | null
  expectedEnd: string | null
  clockInTime: Date | null
  clockOutTime: Date | null
  status: AttendanceStatus
  lateMinutes: number
  earlyLeaveMinutes: number
}

/** Tope inclusivo del reporte de puntualidad, en días. */
export const MAX_REPORT_DAYS = 92

/**
 * Desde qué hora del MISMO día cuenta una checada para un turno que cruza la medianoche: dos horas
 * antes de la entrada, con tope en las 12:00 (para un 22:00–06:00 sigue siendo 12:00; para un
 * 10:00–06:00 es 08:00 — antes se ignoraba la entrada puntual de las 10:00, Codex P2). Misma regla en
 * comisiones.
 */
export function overnightSameDayThreshold(start: string): string {
  const [h, m] = start.split(':').map(Number)
  const minutes = Math.max(0, h * 60 + m - 120)
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  const t = `${hh}:${mm}`
  return t < '12:00' ? t : '12:00'
}

/**
 * Una celda por persona-día de TODO el rango, sin esconder nada: la rejilla es la única
 * verdad que comparten el reporte de puntualidad (que filtra los días sin novedad) y el
 * resumen de nómina de la fase 3 (que necesita también vacaciones, permisos y descansos).
 */
export interface AttendanceGridCell extends AttendanceReportRow {
  /** Tipo de la excepción OFF que ganó ese día (VACATION, SICK_LEAVE…). null = no es ausencia tipificada. */
  absenceType: string | null
}

export async function buildAttendanceGrid(
  venueId: string,
  startDate: string,
  endDate: string,
): Promise<{ cells: AttendanceGridCell[]; graceMinutes: number; timezone: string }> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true, settings: { select: { attendanceGraceMinutes: true, rotatingShiftsEnabled: true } } },
  })
  if (!venue) throw new NotFoundError('Negocio no encontrado')

  const timezone = venue.timezone || 'America/Mexico_City'
  const graceMinutes = venue.settings?.attendanceGraceMinutes ?? 10
  const rotating = venue.settings?.rotatingShiftsEnabled === true

  // Validar ANTES de consultar: un rango absurdo (0001-01-01..9999-12-31) no debe costar ni
  // una consulta, y menos traerse toda la historia del venue (auditoría Codex fase 2, P2-2).
  const start = DateTime.fromISO(startDate, { zone: timezone })
  const end = DateTime.fromISO(endDate, { zone: timezone })
  if (!start.isValid || !end.isValid) throw new BadRequestError('Fechas inválidas')
  if (end < start) throw new BadRequestError('El rango termina antes de empezar')
  // Tope INCLUSIVO: el reporte materializa personas × días en memoria; 92 días cubren un
  // trimestre. Del día 1 al día 92 hay diff 91 — `> 92` dejaba pasar 93 (Codex P2-2).
  if (end.diff(start, 'days').days > MAX_REPORT_DAYS - 1) throw new BadRequestError(`El rango máximo es de ${MAX_REPORT_DAYS} días`)

  const rangeStart = start.startOf('day').toJSDate()
  const rangeEnd = end.endOf('day').toJSDate()

  // Quien estuvo en el equipo en ALGÚN momento del rango, aunque hoy ya no esté: dar de baja
  // pone `active=false, endDate=hoy`, y su historia no debe desaparecer del reporte de la
  // quincena. Y quien entró el día 20 no puede tener faltas del 1 al 19 (Codex P2-4).
  const memberships = await prisma.staffVenue.findMany({
    where: {
      venueId,
      startDate: { lte: rangeEnd },
      OR: [{ active: true, endDate: null }, { endDate: { gte: rangeStart } }],
    },
    select: {
      id: true,
      staffId: true,
      startDate: true,
      endDate: true,
      staff: { select: { firstName: true, lastName: true } },
      workSchedule: { select: { weekly: true } },
      workScheduleExceptions: {
        where: { startDate: { lte: endDate }, endDate: { gte: startDate } },
        // Orden fijo: el desempate final vive en `resolveExpectedDay`, pero la entrada no debe
        // depender del plan de Postgres (Codex P2-6).
        orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
        select: { startDate: true, endDate: true, kind: true, startTime: true, endTime: true, type: true },
      },
      // Turnos rotativos: sólo cuentan las PUBLICADAS, y sólo si el venue los prendió.
      workShiftAssignments: rotating
        ? {
            where: { date: { gte: startDate, lte: endDate }, status: 'PUBLISHED' },
            select: { date: true, startTime: true, endTime: true, status: true },
          }
        : false,
    },
  })

  // Un solo barrido de checadas para todo el rango: pedirlas por persona y por día haría
  // una consulta por celda de la tabla.
  // El tope superior se asoma hasta el MEDIODÍA siguiente al rango: la llegada de las 00:05
  // del día rangeEnd+1 pertenece al turno nocturno que empezó el último día del rango.
  // Hasta el FIN del día siguiente: un turno nocturno puede terminar después del mediodía (Codex P2).
  const entriesUntil = end.plus({ days: 1 }).endOf('day').toJSDate()
  const entries = await prisma.timeEntry.findMany({
    where: { venueId, clockInTime: { gte: rangeStart, lte: entriesUntil } },
    select: { staffId: true, clockInTime: true, clockOutTime: true, validationStatus: true },
    orderBy: { clockInTime: 'asc' },
  })

  interface DayEntry {
    clockInTime: Date
    clockOutTime: Date | null
    /** 'HH:mm' local del negocio, para decidir a qué turno pertenece. */
    localTime: string
  }
  const byStaffAndDay = new Map<string, DayEntry[]>()
  for (const entry of entries) {
    // Una checada RECHAZADA por el gerente no cuenta como presencia: si contara, rechazarla
    // no serviría de nada (auditoría Codex, P2).
    if (entry.validationStatus === 'REJECTED') continue
    const local = DateTime.fromJSDate(entry.clockInTime).setZone(timezone)
    const key = `${entry.staffId}|${local.toISODate()}`
    if (!byStaffAndDay.has(key)) byStaffAndDay.set(key, [])
    byStaffAndDay.get(key)!.push({ clockInTime: entry.clockInTime, clockOutTime: entry.clockOutTime, localTime: local.toFormat('HH:mm') })
  }

  /**
   * A qué DÍA pertenece cada checada (turnos nocturnos, decisión del founder 2026-08-26):
   * en un día con turno que cruza la medianoche cuenta la checada de la TARDE (≥ 12:00) de
   * ese día o, si no la hay, la de la MADRUGADA del día siguiente ANTES de la hora de salida
   * — la llegada tarde después de medianoche. El tope por la hora de salida evita robarle su
   * checada de las 08:55 a un turno diurno del día siguiente cuando el nocturno quedó en
   * falta. Una checada usada por un día no se reusa (`consumed`).
   */
  const consumed = new Set<DayEntry>()
  const pickEntryForDay = (staffId: string, date: string, expected: ExpectedDay): DayEntry | null => {
    const overnight = !!expected.start && !!expected.end && expected.end <= expected.start
    const dayList = byStaffAndDay.get(`${staffId}|${date}`) ?? []
    if (!overnight) return dayList.find(e => !consumed.has(e)) ?? null
    const evening = dayList.find(e => !consumed.has(e) && e.localTime >= overnightSameDayThreshold(expected.start!))
    if (evening) return evening
    const nextDate = DateTime.fromISO(date, { zone: timezone }).plus({ days: 1 }).toISODate()!
    const nextList = byStaffAndDay.get(`${staffId}|${nextDate}`) ?? []
    return nextList.find(e => !consumed.has(e) && e.localTime < expected.end!) ?? null
  }

  // Hoy en la zona del negocio. Un día que aún no termina NO puede ser falta: la persona
  // todavía puede llegar. Días futuros tampoco se juzgan.
  const todayIso = DateTime.now().setZone(timezone).toISODate()!

  const days: string[] = []
  for (let d = start; d <= end; d = d.plus({ days: 1 })) {
    days.push(d.toISODate()!)
  }

  const rows: AttendanceGridCell[] = []
  for (const membership of memberships) {
    const weekly = (membership.workSchedule?.weekly as unknown as WeeklyWorkSchedule) ?? null
    const exceptions = membership.workScheduleExceptions as unknown as WorkScheduleException[]
    // Ventana de pertenencia en fechas del negocio: fuera de ella no se juzga a nadie.
    const joinedIso = DateTime.fromJSDate(membership.startDate).setZone(timezone).toISODate()!
    const leftIso = membership.endDate ? DateTime.fromJSDate(membership.endDate).setZone(timezone).toISODate()! : null

    for (const date of days) {
      if (date < joinedIso || (leftIso && date > leftIso)) continue
      const assignment = rotating
        ? ((
            (membership as any).workShiftAssignments as
              | Array<{ date: string; startTime: string; endTime: string; status: string }>
              | undefined
          )?.find(a => a.date === date) ?? null)
        : null
      const expected = resolveExpectedDay(weekly, exceptions, date, assignment)
      const picked = pickEntryForDay(membership.staffId, date, expected)
      let actual: { clockInTime: Date; clockOutTime: Date | null } | null = null
      if (picked) {
        consumed.add(picked)
        // La PRIMERA entrada manda como llegada; la salida es la ÚLTIMA registrada de ese
        // mismo día (salió a comer y volvió a checar), y esas continuaciones se consumen
        // para que ningún otro día las reuse. SOLO aplica cuando la checada elegida es del
        // MISMO día evaluado y solo hacia adelante: la madrugada del jueves que pertenece
        // al turno nocturno del miércoles no arrastra la checada de la NOCHE del jueves,
        // que es de su propio turno.
        const pickedDate = DateTime.fromJSDate(picked.clockInTime).setZone(timezone).toISODate()
        let clockOutTime = picked.clockOutTime
        if (pickedDate === date) {
          for (const sib of byStaffAndDay.get(`${membership.staffId}|${pickedDate}`) ?? []) {
            if (sib === picked || consumed.has(sib) || sib.localTime <= picked.localTime) continue
            consumed.add(sib)
            clockOutTime = sib.clockOutTime ?? clockOutTime
          }
        }
        actual = { clockInTime: picked.clockInTime, clockOutTime }
      }

      // Sin checada en un día que no ha terminado (hoy o futuro): pendiente, no falta.
      const dayStillOpen = date >= todayIso
      const evaluation =
        !actual && dayStillOpen && !expected.isDayOff && expected.start
          ? { status: 'PENDING' as const, lateMinutes: 0, earlyLeaveMinutes: 0 }
          : evaluateAttendance({
              expectedStart: expected.start,
              expectedEnd: expected.end,
              timezone,
              graceMinutes,
              scheduleDate: date,
              clockInTime: actual?.clockInTime ?? null,
              clockOutTime: actual?.clockOutTime ?? null,
              isDayOff: expected.isDayOff,
            })

      rows.push({
        absenceType: expected.isDayOff ? (expected.absenceType ?? null) : null,
        staffId: membership.staffId,
        staffVenueId: membership.id,
        name: `${membership.staff.firstName} ${membership.staff.lastName}`.trim(),
        date,
        expectedStart: expected.start,
        expectedEnd: expected.end,
        clockInTime: actual?.clockInTime ?? null,
        clockOutTime: actual?.clockOutTime ?? null,
        ...evaluation,
      })
    }
  }

  rows.sort((a, b) => (a.date === b.date ? a.name.localeCompare(b.name) : b.date.localeCompare(a.date)))
  return { cells: rows, graceMinutes, timezone }
}

export async function getAttendanceReport(
  venueId: string,
  startDate: string,
  endDate: string,
): Promise<{ rows: AttendanceReportRow[]; graceMinutes: number; timezone: string }> {
  const { cells, graceMinutes, timezone } = await buildAttendanceGrid(venueId, startDate, endDate)
  // Los días sin nada que contar no llegan a la pantalla: descanso sin novedad y gente
  // sin cuadrante que tampoco marcó. Llenar la tabla de filas vacías la vuelve ilegible.
  const rows = cells.filter(c => !((c.status === 'DAY_OFF' || c.status === 'NO_SCHEDULE' || c.status === 'PENDING') && !c.clockInTime))
  return { rows, graceMinutes, timezone }
}
