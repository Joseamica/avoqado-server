import { DateTime } from 'luxon'

import logger from '../../../config/logger'
import prisma from '../../../utils/prismaClient'
import { evaluateAttendance } from '../attendanceEvaluator'
import { resolveExpectedDay, type WeeklyWorkSchedule, type WorkScheduleException } from '../workSchedule.service'

/**
 * Asistencia → comisiones (decisión del founder, 2026-08-26).
 *
 * Una regla POR ESQUEMA (`CommissionConfig.attendanceLinked`), apagada de fábrica: prendida,
 * la comisión de un día en que la persona llegó TARDE (fuera de la tolerancia del venue) se
 * recorta en `attendanceLatePenaltyRate` (0.25 = pierde el 25% de ese día).
 *
 * Lo que la regla NO hace, a propósito:
 * - No castiga la FALTA: un día sin venir no genera ventas, no hay comisión que descontar.
 *   (Mercado: no hay referente directo en POS — Square/Toast no ligan comisión con asistencia;
 *   el patrón general es "puntos de asistencia" hacia nómina, con el principio de que llegar
 *   tarde debe costar menos que no llegar. Divergencia consciente y conservadora.)
 * - No juzga sin cuadrante, en día libre ni con la asistencia del venue apagada: nadie está
 *   obligado a usar el checador para cobrar comisiones ("no stopper", regla del founder).
 * - 🔴 FALLA ABIERTA: cualquier error evaluando asistencia ⇒ comisión COMPLETA + warn. El
 *   camino del dinero nunca se cae por culpa del checador.
 */

interface AttendanceRuleConfig {
  attendanceLinked: boolean
  attendanceLatePenaltyRate: number | { toString(): string } | null
}

export interface ResolvePenaltyParams {
  config: AttendanceRuleConfig
  staffId: string
  venueId: string
  /** Instante del pago: define QUÉ día (calendario del venue) se juzga. */
  at: Date
}

/** Recorta `net` en `rate` (0–1) y redondea a centavos. null/0 = intacto. */
export function applyAttendancePenalty(net: number, rate: number | null): number {
  if (!rate || rate <= 0) return net
  return Math.round(net * (1 - rate) * 100) / 100
}

/**
 * Porcentaje de castigo que aplica a la comisión de este pago, o null si no aplica ninguno.
 * Sólo devuelve un valor cuando el día del pago quedó como LATE fuera de tolerancia.
 */
export async function resolveAttendancePenaltyRate(params: ResolvePenaltyParams): Promise<number | null> {
  const { config, staffId, venueId, at } = params
  if (!config.attendanceLinked) return null
  const rate = Number(config.attendanceLatePenaltyRate ?? 0)
  if (!Number.isFinite(rate) || rate <= 0) return null

  try {
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: {
        timezone: true,
        settings: { select: { attendanceEnabled: true, attendanceGraceMinutes: true, rotatingShiftsEnabled: true } },
      },
    })
    if (!venue) return null
    // Venue con el checador apagado: la regla es inerte, sin consultar nada más.
    if (venue.settings?.attendanceEnabled === false) return null

    const timezone = venue.timezone || 'America/Mexico_City'
    const graceMinutes = venue.settings?.attendanceGraceMinutes ?? 10
    const day = DateTime.fromJSDate(at).setZone(timezone)
    const dateIso = day.toISODate()!

    const rotating = (venue.settings as any)?.rotatingShiftsEnabled === true
    const prevIso = day.minus({ days: 1 }).toISODate()!
    const membership = await prisma.staffVenue.findFirst({
      where: { staffId, venueId },
      select: {
        workSchedule: { select: { weekly: true } },
        workScheduleExceptions: {
          where: { startDate: { lte: dateIso }, endDate: { gte: prevIso } },
          select: { startDate: true, endDate: true, kind: true, startTime: true, endTime: true },
        },
        ...(rotating
          ? {
              workShiftAssignments: {
                where: { date: { in: [dateIso, prevIso] }, status: 'PUBLISHED' },
                select: { date: true, startTime: true, endTime: true, status: true },
              },
            }
          : {}),
      },
    })
    if (!membership) return null
    const weekly = (membership.workSchedule?.weekly as unknown as WeeklyWorkSchedule) ?? null
    const exceptions = membership.workScheduleExceptions as unknown as WorkScheduleException[]
    const assignments = ((membership as any).workShiftAssignments ?? []) as Array<{
      date: string
      startTime: string
      endTime: string
      status: string
    }>
    const expectedFor = (iso: string) => resolveExpectedDay(weekly, exceptions, iso, assignments.find(a => a.date === iso) ?? null)

    // 🔴 Misma regla que el reporte de asistencia (Codex 27-ago: divergían). Una venta de madrugada
    // pertenece al turno NOCTURNO del día anterior si ese turno cruza la medianoche y la venta cae
    // antes de su hora de salida; si no, al turno del día. Y para el turno nocturno cuenta la
    // checada de la TARDE (≥ 12:00) de su día o, si no la hay, la de la madrugada siguiente antes
    // de la salida.
    let scheduleDate = dateIso
    let expected = expectedFor(dateIso)
    const localTime = day.toFormat('HH:mm')
    const prevExpected = expectedFor(prevIso)
    const prevOvernight = !prevExpected.isDayOff && !!prevExpected.start && !!prevExpected.end && prevExpected.end <= prevExpected.start
    if (prevOvernight && localTime < prevExpected.end!) {
      scheduleDate = prevIso
      expected = prevExpected
    }
    if (expected.isDayOff || !expected.start || !expected.end) return null
    const shiftDay = DateTime.fromISO(scheduleDate, { zone: timezone })
    const overnight = expected.end <= expected.start
    const entries = await prisma.timeEntry.findMany({
      where: {
        venueId,
        staffId,
        clockInTime: {
          gte: shiftDay.startOf('day').toJSDate(),
          lte: shiftDay.plus({ days: 1 }).startOf('day').plus({ hours: 12 }).toJSDate(),
        },
        validationStatus: { not: 'REJECTED' },
      },
      orderBy: { clockInTime: 'asc' },
      select: { clockInTime: true },
    })
    const withLocal = entries.map(e => {
      const local = DateTime.fromJSDate(e.clockInTime).setZone(timezone)
      return { clockInTime: e.clockInTime, dateIso: local.toISODate()!, localTime: local.toFormat('HH:mm') }
    })
    const entry = overnight
      ? (withLocal.find(e => e.dateIso === scheduleDate && e.localTime >= '12:00') ??
        withLocal.find(e => e.dateIso !== scheduleDate && e.localTime < expected.end!) ??
        null)
      : (withLocal.find(e => e.dateIso === scheduleDate) ?? null)
    if (!entry) return null
    const evaluation = evaluateAttendance({
      expectedStart: expected.start,
      expectedEnd: expected.end,
      timezone,
      graceMinutes,
      clockInTime: entry.clockInTime,
      scheduleDate,
    })
    return evaluation.status === 'LATE' ? rate : null
  } catch (error) {
    logger.warn('asistencia→comisiones: no se pudo evaluar el día; la comisión se paga completa (falla abierta)', {
      staffId,
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
