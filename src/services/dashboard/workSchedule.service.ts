import { DateTime } from 'luxon'

import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'

/**
 * Cuadrante laboral: a qué hora se espera que entre y salga una persona cada día.
 *
 * 🔴 No confundir con `staffSchedule.service`, que es la DISPONIBILIDAD PARA CITAS (a qué
 * horas puede atender clientes), ni con los turnos de caja. Tres cosas distintas.
 */

export interface DayRange {
  open: string
  close: string
}

export interface DaySchedule {
  enabled: boolean
  ranges: DayRange[]
}

export type WeeklyWorkSchedule = Record<string, DaySchedule>

export interface WorkScheduleException {
  startDate: string
  endDate: string
  kind: 'OFF' | 'HOURS'
  startTime?: string | null
  endTime?: string | null
  /**
   * Fase 3: por qué no viene (sólo kind=OFF). null = descanso simple. Referente Sesame:
   * vacaciones · permiso con/sin goce · incapacidad · falta justificada.
   */
  type?: string | null
}

export interface ExpectedDay {
  start: string | null
  end: string | null
  isDayOff: boolean
  /** Tipo de la excepción OFF ganadora (VACATION, SICK_LEAVE…). null = descanso sin más. */
  absenceType?: string | null
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

const NOTHING_EXPECTED: ExpectedDay = { start: null, end: null, isDayOff: false }

/** Días que cubre un rango 'YYYY-MM-DD'..'YYYY-MM-DD'. Sirve para elegir la más específica. */
function spanDays(exception: WorkScheduleException): number {
  const from = DateTime.fromISO(exception.startDate)
  const to = DateTime.fromISO(exception.endDate)
  if (!from.isValid || !to.isValid) return Number.MAX_SAFE_INTEGER
  return Math.max(0, Math.round(to.diff(from, 'days').days))
}

/**
 * Qué se esperaba de esta persona ESE día.
 *
 * Precedencia: una excepción puntual gana sobre el cuadrante semanal — si no, alguien de
 * vacaciones aparece como falta todos los días. Y entre excepciones que se solapan gana la
 * MÁS CORTA: unas vacaciones de una semana con un día suelto para cubrir un turno tienen
 * que resolverse a favor del día suelto, que es la instrucción más reciente y más precisa.
 */
/** Asignación de turno rotativo para un día (fase 1 "como Sesame"). Sólo cuenta si está PUBLICADA. */
export interface ShiftAssignmentForDay {
  startTime: string
  endTime: string
  status?: string
}

export function resolveExpectedDay(
  weekly: WeeklyWorkSchedule | null | undefined,
  exceptions: WorkScheduleException[],
  dateIso: string,
  assignment?: ShiftAssignmentForDay | null,
): ExpectedDay {
  // Desempate determinista (Codex P2-6): misma duración → gana OFF sobre HOURS (descansar es
  // la instrucción más conservadora: no genera una falta), y luego la que empieza más tarde
  // (la más reciente). Sin esto, dos excepciones del mismo día dependían del orden de Postgres.
  const applicable = (exceptions ?? [])
    .filter(e => e.startDate <= dateIso && dateIso <= e.endDate)
    .sort(
      (a, b) =>
        spanDays(a) - spanDays(b) || (a.kind === 'OFF' ? 0 : 1) - (b.kind === 'OFF' ? 0 : 1) || b.startDate.localeCompare(a.startDate),
    )

  const winner = applicable[0]
  if (winner) {
    if (winner.kind === 'OFF') return { start: null, end: null, isDayOff: true, absenceType: winner.type ?? null }
    if (winner.startTime && winner.endTime) {
      return { start: winner.startTime, end: winner.endTime, isDayOff: false }
    }
    // HOURS sin horas es un dato incompleto: se ignora y se cae al cuadrante.
  }

  // Turnos rotativos: la asignación PUBLICADA va entre la excepción y la jornada fija. Un borrador
  // no cuenta — publicar es la instrucción; armar la semana es trabajo en curso.
  if (assignment && (assignment.status ?? 'PUBLISHED') === 'PUBLISHED' && assignment.startTime && assignment.endTime) {
    return { start: assignment.startTime, end: assignment.endTime, isDayOff: false }
  }

  if (!weekly) return NOTHING_EXPECTED

  const date = DateTime.fromISO(dateIso)
  if (!date.isValid) return NOTHING_EXPECTED

  const day = weekly[WEEKDAYS[date.weekday - 1]]
  // Un día apagado, o habilitado pero sin rangos, es descanso — no un horario vacío contra
  // el que juzgar a alguien.
  if (!day?.enabled || !day.ranges?.length) return { start: null, end: null, isDayOff: true }

  // Turno partido (9-14 y 16-20): se entra en el primer rango y se sale en el último.
  return {
    start: day.ranges[0].open,
    end: day.ranges[day.ranges.length - 1].close,
    isDayOff: false,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistencia y reporte
// ─────────────────────────────────────────────────────────────────────────────

/** Cuadrante de una persona, o null si aún no tiene. */
export async function getWorkSchedule(venueId: string, staffVenueId: string) {
  await requireMembershipOfVenue(venueId, staffVenueId)

  const [schedule, exceptions] = await Promise.all([
    prisma.staffWorkSchedule.findUnique({ where: { staffVenueId } }),
    prisma.staffWorkScheduleException.findMany({ where: { staffVenueId }, orderBy: { startDate: 'asc' } }),
  ])

  return {
    weekly: (schedule?.weekly as unknown as WeeklyWorkSchedule) ?? null,
    exceptions: exceptions.map(e => ({
      id: e.id,
      startDate: e.startDate,
      endDate: e.endDate,
      kind: e.kind as 'OFF' | 'HOURS',
      startTime: e.startTime,
      endTime: e.endTime,
      note: e.note,
      type: e.type,
    })),
  }
}

/** Reemplaza el cuadrante completo. Es un solo objeto: se guarda entero o no se guarda. */
export async function replaceWorkSchedule(
  venueId: string,
  staffVenueId: string,
  input: { weekly: WeeklyWorkSchedule | null; exceptions: Array<WorkScheduleException & { note?: string | null }> },
  actorId: string,
) {
  await requireMembershipOfVenue(venueId, staffVenueId)

  for (const exception of input.exceptions ?? []) {
    if (exception.startDate > exception.endDate) {
      throw new BadRequestError('Una excepción no puede terminar antes de empezar.')
    }
    if (exception.kind === 'HOURS' && (!exception.startTime || !exception.endTime)) {
      throw new BadRequestError('Un día con horario distinto necesita hora de entrada y de salida.')
    }
    if (exception.type && exception.kind !== 'OFF') {
      throw new BadRequestError('Un tipo de ausencia sólo aplica a días sin turno (OFF): cambiar el horario no es faltar.')
    }
  }

  await prisma.$transaction(async tx => {
    if (input.weekly) {
      await tx.staffWorkSchedule.upsert({
        where: { staffVenueId },
        create: { staffVenueId, venueId, weekly: input.weekly as unknown as object },
        update: { weekly: input.weekly as unknown as object },
      })
    } else {
      await tx.staffWorkSchedule.deleteMany({ where: { staffVenueId } })
    }

    // Las excepciones se reemplazan en bloque: la pantalla manda la lista completa, así que
    // un borrado parcial dejaría fantasmas que nadie pidió conservar.
    await tx.staffWorkScheduleException.deleteMany({ where: { staffVenueId } })
    if (input.exceptions?.length) {
      await tx.staffWorkScheduleException.createMany({
        data: input.exceptions.map(e => ({
          staffVenueId,
          venueId,
          startDate: e.startDate,
          endDate: e.endDate,
          kind: e.kind,
          startTime: e.startTime ?? null,
          endTime: e.endTime ?? null,
          note: e.note ?? null,
          type: e.type ?? null,
        })),
      })
    }
  })

  logAction({
    staffId: actorId,
    venueId,
    action: 'WORK_SCHEDULE_UPDATED',
    entity: 'StaffWorkSchedule',
    entityId: staffVenueId,
    data: { exceptions: input.exceptions?.length ?? 0, hasWeekly: !!input.weekly },
  })

  return getWorkSchedule(venueId, staffVenueId)
}

async function requireMembershipOfVenue(venueId: string, staffVenueId: string): Promise<{ staffId: string }> {
  const membership = await prisma.staffVenue.findFirst({
    where: { id: staffVenueId, venueId },
    select: { staffId: true },
  })
  if (!membership) throw new NotFoundError('Ese empleado no pertenece a este negocio')
  return membership
}
