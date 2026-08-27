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
      select: { timezone: true, settings: { select: { attendanceEnabled: true, attendanceGraceMinutes: true } } },
    })
    if (!venue) return null
    // Venue con el checador apagado: la regla es inerte, sin consultar nada más.
    if (venue.settings?.attendanceEnabled === false) return null

    const timezone = venue.timezone || 'America/Mexico_City'
    const graceMinutes = venue.settings?.attendanceGraceMinutes ?? 10
    const day = DateTime.fromJSDate(at).setZone(timezone)
    const dateIso = day.toISODate()!

    const membership = await prisma.staffVenue.findFirst({
      where: { staffId, venueId },
      select: {
        workSchedule: { select: { weekly: true } },
        workScheduleExceptions: {
          where: { startDate: { lte: dateIso }, endDate: { gte: dateIso } },
          select: { startDate: true, endDate: true, kind: true, startTime: true, endTime: true },
        },
      },
    })
    if (!membership) return null

    const expected = resolveExpectedDay(
      (membership.workSchedule?.weekly as unknown as WeeklyWorkSchedule) ?? null,
      membership.workScheduleExceptions as unknown as WorkScheduleException[],
      dateIso,
    )
    // Sin cuadrante o día libre: no se juzga (mismo principio que el reporte).
    if (expected.isDayOff || !expected.start || !expected.end) return null

    // La PRIMERA checada no rechazada del día calendario del pago. Una checada RECHAZADA por
    // el gerente no cuenta como presencia (misma regla que el reporte de puntualidad).
    const entry = await prisma.timeEntry.findFirst({
      where: {
        venueId,
        staffId,
        clockInTime: { gte: day.startOf('day').toJSDate(), lte: day.endOf('day').toJSDate() },
        validationStatus: { not: 'REJECTED' },
      },
      orderBy: { clockInTime: 'asc' },
      select: { clockInTime: true },
    })
    // Falta (sin checada): no genera ventas — y si este pago existe con otra atribución, el
    // castigo por falta no está definido. Sólo el retardo castiga.
    if (!entry) return null

    const evaluation = evaluateAttendance({
      expectedStart: expected.start,
      expectedEnd: expected.end,
      timezone,
      graceMinutes,
      clockInTime: entry.clockInTime,
      scheduleDate: dateIso,
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
