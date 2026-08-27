import { DateTime } from 'luxon'

import prisma from '../../utils/prismaClient'
import { buildAttendanceGrid } from './attendance.dashboard.service'

/**
 * Fase 3 del checador — el puente a nómina.
 *
 * Un renglón por persona con los números que una nómina necesita del periodo: días exigibles,
 * trabajados, retardos (y sus minutos), faltas, ausencias POR TIPO (vacaciones, permiso con y
 * sin goce, incapacidad, falta justificada — referente Sesame, buscado en vivo 2026-08-26) y
 * horas trabajadas. Sale de la MISMA rejilla que el reporte de puntualidad: una sola verdad.
 *
 * Lo que NO es (v1, declarado): no calcula dinero ni integra con un sistema de nómina — entrega
 * los números listos para exportar. Las SOLICITUDES de vacaciones del empleado tampoco viven
 * aquí: los empleados no tienen dashboard; el negocio captura.
 */

export interface PayrollSummaryRow {
  staffId: string
  staffVenueId: string
  name: string
  /** Días con turno exigible en el periodo (a tiempo + tarde + falta + pendientes). */
  scheduledDays: number
  workedDays: number
  onTimeDays: number
  lateDays: number
  lateMinutesTotal: number
  absentDays: number
  pendingDays: number
  /** Ausencias tipificadas del periodo: { VACATION: 5, SICK_LEAVE: 2, … }. El descanso simple no cuenta. */
  absences: Record<string, number>
  hoursWorked: number
  breakMinutes: number
}

export async function getPayrollSummary(
  venueId: string,
  startDate: string,
  endDate: string,
): Promise<{ rows: PayrollSummaryRow[]; timezone: string; startDate: string; endDate: string }> {
  const { cells, timezone } = await buildAttendanceGrid(venueId, startDate, endDate)

  // Horas y descansos del periodo, por persona, EXCLUYENDO checadas rechazadas por el gerente
  // (misma regla que la rejilla: una checada rechazada no cuenta como presencia).
  const rangeStart = DateTime.fromISO(startDate, { zone: timezone }).startOf('day').toJSDate()
  const rangeEnd = DateTime.fromISO(endDate, { zone: timezone }).endOf('day').toJSDate()
  const hours = await prisma.timeEntry.groupBy({
    by: ['staffId'],
    where: { venueId, clockInTime: { gte: rangeStart, lte: rangeEnd }, validationStatus: { not: 'REJECTED' } },
    _sum: { totalHours: true, breakMinutes: true },
  })
  const hoursByStaff = new Map(hours.map(h => [h.staffId, h._sum]))

  const byMembership = new Map<string, PayrollSummaryRow>()
  for (const cell of cells) {
    let row = byMembership.get(cell.staffVenueId)
    if (!row) {
      const sum = hoursByStaff.get(cell.staffId)
      row = {
        staffId: cell.staffId,
        staffVenueId: cell.staffVenueId,
        name: cell.name,
        scheduledDays: 0,
        workedDays: 0,
        onTimeDays: 0,
        lateDays: 0,
        lateMinutesTotal: 0,
        absentDays: 0,
        pendingDays: 0,
        absences: {},
        hoursWorked: Number(Number(sum?.totalHours ?? 0).toFixed(2)),
        breakMinutes: Number(sum?.breakMinutes ?? 0),
      }
      byMembership.set(cell.staffVenueId, row)
    }

    if (cell.clockInTime) row.workedDays += 1
    switch (cell.status) {
      case 'ON_TIME':
        row.scheduledDays += 1
        row.onTimeDays += 1
        // Los minutos DENTRO de la tolerancia no se acumulan: acumularlos convertiría la
        // tolerancia en una mentira contable.
        break
      case 'LATE':
        row.scheduledDays += 1
        row.lateDays += 1
        row.lateMinutesTotal += cell.lateMinutes
        break
      case 'ABSENT':
        row.scheduledDays += 1
        row.absentDays += 1
        break
      case 'PENDING':
        row.scheduledDays += 1
        row.pendingDays += 1
        break
      case 'DAY_OFF':
        // El descanso simple (semanal o excepción sin tipo) no es una ausencia que la nómina
        // cuente; una vacación o incapacidad sí.
        if (cell.absenceType && cell.absenceType !== 'REST') {
          row.absences[cell.absenceType] = (row.absences[cell.absenceType] ?? 0) + 1
        }
        break
      case 'NO_SCHEDULE':
      default:
        break
    }
  }

  const rows = [...byMembership.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, timezone, startDate, endDate }
}
