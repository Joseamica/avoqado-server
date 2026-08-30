import { buildAttendanceGrid } from './attendance.dashboard.service'
import prisma from '../../utils/prismaClient'
import { agruparPorSemana, diasAutorizadosParaReparto, resumirAutorizacion, type DiaAutorizado, type SemanaDeExtra } from './overtime'

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
  /** Minutos extra MEDIDOS por el reloj (art. 66-68 LFT). Llegar temprano no cuenta — ver `overtime.ts`. */
  overtimeMinutes: number
  /** De lo medido, lo que alguien AUTORIZÓ. Es lo único que se reparte en doble y triple. */
  overtimeApprovedMinutes: number
  /** Medido en días que NADIE ha revisado. Es lo que el negocio tiene pendiente de mirar. */
  overtimePendingMinutes: number
  /** Medido que sí se revisó y NO se autorizó. */
  overtimeDeniedMinutes: number
  /** Días donde la checada cambió DESPUÉS de autorizar: hay que volver a mirarlos. */
  overtimeDaysToReview: string[]
  /** De lo AUTORIZADO, lo que se paga al DOBLE (art. 67): las primeras 9 h de cada semana. */
  overtimeDoubleMinutes: number
  /** De lo AUTORIZADO, lo que se paga al TRIPLE (art. 68): lo que excede 9 h en una semana. */
  overtimeTripleMinutes: number
  /** El desglose semana por semana de lo AUTORIZADO, que es donde vive el umbral. */
  overtimeWeeks: SemanaDeExtra[]
  /**
   * Alguna semana rompe el art. 66 (más de 3 h en un día, o extra en más de 3 días).
   * Es una infracción que el dueño debe VER; no cambia lo que se paga.
   */
  hasOvertimeViolation: boolean
}

export async function getPayrollSummary(
  venueId: string,
  startDate: string,
  endDate: string,
): Promise<{ rows: PayrollSummaryRow[]; timezone: string; startDate: string; endDate: string }> {
  const { cells, timezone, workedTotalsByStaff } = await buildAttendanceGrid(venueId, startDate, endDate)

  const byMembership = new Map<string, PayrollSummaryRow>()
  // Los días con extra se juntan por PERSONA y se reparten al final: el umbral doble/triple
  // es semanal, así que celda por celda no se puede decidir la tarifa.
  const extraPorMembresia = new Map<string, Array<{ date: string; minutos: number }>>()

  for (const cell of cells) {
    let row = byMembership.get(cell.staffVenueId)
    if (!row) {
      const sum = workedTotalsByStaff.get(cell.staffId)
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
        overtimeMinutes: 0,
        overtimeApprovedMinutes: 0,
        overtimePendingMinutes: 0,
        overtimeDeniedMinutes: 0,
        overtimeDaysToReview: [],
        overtimeDoubleMinutes: 0,
        overtimeTripleMinutes: 0,
        overtimeWeeks: [],
        hasOvertimeViolation: false,
      }
      byMembership.set(cell.staffVenueId, row)
    }

    if (cell.overtimeMinutes > 0) {
      const dias = extraPorMembresia.get(cell.staffVenueId)
      if (dias) dias.push({ date: cell.date, minutos: cell.overtimeMinutes })
      else extraPorMembresia.set(cell.staffVenueId, [{ date: cell.date, minutos: cell.overtimeMinutes }])
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

  // Las autorizaciones del periodo. Una consulta para todas las personas: pedirlas por
  // renglón haría una por empleado.
  const autorizaciones = extraPorMembresia.size
    ? await prisma.overtimeApproval.findMany({
        where: { staffVenueId: { in: [...extraPorMembresia.keys()] }, date: { gte: startDate, lte: endDate } },
        select: { staffVenueId: true, date: true, minutesApproved: true, minutesMeasured: true },
      })
    : []
  const porPersonaYDia = new Map<string, { minutesApproved: number; minutesMeasured: number }>()
  for (const a of autorizaciones) {
    porPersonaYDia.set(`${a.staffVenueId}|${a.date}`, {
      minutesApproved: a.minutesApproved,
      minutesMeasured: a.minutesMeasured,
    })
  }

  for (const [staffVenueId, dias] of extraPorMembresia) {
    const row = byMembership.get(staffVenueId)
    if (!row) continue

    const conAutorizacion: DiaAutorizado[] = dias.map(d => {
      const a = porPersonaYDia.get(`${staffVenueId}|${d.date}`)
      return {
        date: d.date,
        medidos: d.minutos,
        // `null` = sin revisar. Es distinto de 0 = revisado y negado, y esa diferencia es la
        // que impide que no pagar se vuelva invisible.
        autorizados: a ? a.minutesApproved : null,
        medidosAlAutorizar: a ? a.minutesMeasured : null,
      }
    })

    const resumen = resumirAutorizacion(conAutorizacion)
    row.overtimeMinutes = resumen.minutosMedidos
    row.overtimeApprovedMinutes = resumen.minutosAutorizados
    row.overtimePendingMinutes = resumen.minutosPendientes
    row.overtimeDeniedMinutes = resumen.minutosNegados
    row.overtimeDaysToReview = resumen.diasPorRevisar

    // 🔴 El reparto doble/triple va sobre lo AUTORIZADO: es lo que se paga.
    const semanas = agruparPorSemana(diasAutorizadosParaReparto(conAutorizacion), { startDate, endDate })
    row.overtimeWeeks = semanas
    row.overtimeDoubleMinutes = semanas.reduce((t, w) => t + w.minutosDobles, 0)
    row.overtimeTripleMinutes = semanas.reduce((t, w) => t + w.minutosTriples, 0)

    // 🔴 …pero la INFRACCIÓN del art. 66 se juzga sobre lo MEDIDO. Si alguien trabajó 4 h
    // extra en un día, la ley se rompió aunque el gerente sólo autorice una: no autorizar no
    // deshace lo que ya pasó.
    const semanasMedidas = agruparPorSemana(dias, { startDate, endDate })
    row.hasOvertimeViolation = semanasMedidas.some(w => w.diasSobreTopeDiario.length > 0 || w.excedeDiasPermitidos)
  }

  const rows = [...byMembership.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, timezone, startDate, endDate }
}
