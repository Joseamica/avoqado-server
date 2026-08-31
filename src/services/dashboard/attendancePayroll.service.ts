import { buildAttendanceGrid } from './attendance.dashboard.service'
import prisma from '../../utils/prismaClient'
import { DateTime } from 'luxon'

import {
  agruparPorSemana,
  diasAutorizadosParaReparto,
  minutosAutorizadosEfectivos,
  resumirAutorizacion,
  type DiaAutorizado,
  type SemanaDeExtra,
} from './overtime'

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
  /** Minutos extra MEDIDOS por el reloj. Llegar temprano no cuenta — ver `overtime.ts`. */
  overtimeMinutes: number
  /** De lo medido, lo que alguien AUTORIZÓ. Es lo único que sale hacia la nómina. */
  overtimeApprovedMinutes: number
  /** Medido en días que NADIE ha revisado. Es lo que el negocio tiene pendiente de mirar. */
  overtimePendingMinutes: number
  /** Medido que sí se revisó y NO se autorizó. */
  overtimeDeniedMinutes: number
  /** Días donde la checada cambió DESPUÉS de autorizar: hay que volver a mirarlos. */
  overtimeDaysToReview: string[]
  /**
   * Los minutos AUTORIZADOS repartidos por semana — la materia prima para que el sistema de
   * nómina aplique la tarifa que corresponda.
   *
   * 🔴 Decisión del founder (31-ago-2026): **Avoqado mide y autoriza; NO dictamina la ley.**
   * Antes esto traía además el reparto doble/triple (art. 67-68) y una bandera de infracción
   * del art. 66. Se retiraron los dos.
   *
   * El porqué, con datos: cinco auditorías seguidas encontraron defectos, y en la última
   * **3 de 6 estaban en esa parte legal** — el tope semanal en rangos parciales, aplicar la
   * reforma de mayo a reportes anteriores, y la semana que cruza el 1-ene-2028, que ni el
   * código ni una auditoría pueden resolver porque necesita criterio de un abogado laboral.
   * Los tres límites del art. 66 cambiaron en mayo de 2026 y siguen cambiando cada año hasta
   * 2030.
   *
   * 🔑 Y el argumento de fondo, del founder: **la ley la cumple el patrón, no el software.**
   * Equivocarnos aquí no sólo da un número malo: le da al dueño una tranquilidad falsa sobre
   * su cumplimiento. El sistema de nómina del negocio ya aplica la ley y se actualiza cuando
   * cambia; Avoqado le entrega los minutos, que es lo que sí sabe medir bien.
   */
  overtimeWeeks: Array<{ weekStart: string; weekEnd: string; minutosTotal: number; parcial: boolean }>
}

export async function getPayrollSummary(
  venueId: string,
  startDate: string,
  endDate: string,
): Promise<{ rows: PayrollSummaryRow[]; timezone: string; startDate: string; endDate: string }> {
  const { cells, timezone, workedTotalsByStaff } = await buildAttendanceGrid(venueId, startDate, endDate)

  // 🔴 Si el rango empieza a media semana, los días de esa semana que quedan FUERA ya
  // consumieron parte del umbral de 9 h. Sin ellos, las horas del rango se pagarían al doble
  // cuando algunas iban al TRIPLE (hallazgo #2 de Codex, 29-ago-2026). Se consulta desde el
  // LUNES de la primera semana; esos días sólo mueven el umbral y nunca se re-reportan.

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
        overtimeWeeks: [],
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
        select: { staffVenueId: true, date: true, minutesApproved: true, minutesMeasured: true, sourceFingerprint: true },
      })
    : []
  const porPersonaYDia = new Map<string, { minutesApproved: number; minutesMeasured: number; sourceFingerprint: string | null }>()
  for (const a of autorizaciones) {
    porPersonaYDia.set(`${a.staffVenueId}|${a.date}`, {
      minutesApproved: a.minutesApproved,
      minutesMeasured: a.minutesMeasured,
      sourceFingerprint: a.sourceFingerprint,
    })
  }
  // La huella de la jornada TAL COMO ESTÁ HOY, por celda.
  const huellaDeHoy = new Map<string, string | null>()
  for (const c of cells) huellaDeHoy.set(`${c.staffVenueId}|${c.date}`, c.overtimeFingerprint)

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
        huellaActual: huellaDeHoy.get(`${staffVenueId}|${d.date}`) ?? null,
        huellaAlAutorizar: a ? a.sourceFingerprint : null,
      }
    })

    const resumen = resumirAutorizacion(conAutorizacion)
    row.overtimeMinutes = resumen.minutosMedidos
    row.overtimeApprovedMinutes = resumen.minutosAutorizados
    row.overtimePendingMinutes = resumen.minutosPendientes
    row.overtimeDeniedMinutes = resumen.minutosNegados
    row.overtimeDaysToReview = resumen.diasPorRevisar

    // Los minutos AUTORIZADOS repartidos por semana. Sin tarifas y sin veredictos: es el dato
    // que el sistema de nómina necesita para aplicar la ley que corresponda ese año.
    //
    // 🔴 `parcial` viaja porque importa: significa que el rango consultado no cubre la semana
    // entera, así que ese total todavía puede crecer. Callarlo invitaría a tratarlo como final.
    row.overtimeWeeks = agruparPorSemana(diasAutorizadosParaReparto(conAutorizacion), { startDate, endDate }).map(w => ({
      weekStart: w.weekStart,
      weekEnd: w.weekEnd,
      minutosTotal: w.minutosTotal,
      parcial: w.parcial,
    }))
  }

  const rows = [...byMembership.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, timezone, startDate, endDate }
}
