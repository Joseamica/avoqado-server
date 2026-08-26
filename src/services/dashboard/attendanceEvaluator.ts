import { DateTime } from 'luxon'

/**
 * Decide si una jornada fue puntual, tarde o falta.
 *
 * 🔴 La trampa de todo el checador: el horario se escribe en hora del NEGOCIO ("Ana entra a
 * las 9:00") y la checada se guarda en UTC. Comparar sin la zona del venue hace que en
 * México todo el mundo llegue seis horas tarde. Por eso la zona es un parámetro OBLIGATORIO
 * y no tiene default: olvidarla debe romper la llamada, no producir un resultado plausible
 * y equivocado.
 *
 * Función pura: es la pieza con más casos borde del checador y así se prueba sin base de
 * datos ni relojes falsos.
 */

/** PENDING = el día aún no termina y no ha marcado: no es falta todavía. */
export type AttendanceStatus = 'ON_TIME' | 'LATE' | 'ABSENT' | 'DAY_OFF' | 'NO_SCHEDULE' | 'PENDING'

export interface EvaluateAttendanceInput {
  /** Hora de entrada esperada, "HH:mm" en hora del negocio. Null = sin cuadrante. */
  expectedStart: string | null
  /** Hora de salida esperada, "HH:mm" en hora del negocio. Null = sin cuadrante. */
  expectedEnd: string | null
  /** Zona del negocio (IANA). Obligatoria a propósito. */
  timezone: string
  /** Minutos de gracia antes de considerar tarde. */
  graceMinutes: number
  clockInTime: Date | null
  clockOutTime?: Date | null
  /** Día de descanso: ni la falta ni el retardo aplican. */
  isDayOff?: boolean
}

export interface AttendanceEvaluation {
  status: AttendanceStatus
  /** Minutos REALES de retraso, no los que exceden la tolerancia. */
  lateMinutes: number
  earlyLeaveMinutes: number
}

const none = (status: AttendanceStatus): AttendanceEvaluation => ({ status, lateMinutes: 0, earlyLeaveMinutes: 0 })

/** "09:00" + el día del instante dado, en la zona del negocio. */
function expectedMoment(reference: DateTime, hhmm: string): DateTime {
  const [hour, minute] = hhmm.split(':').map(Number)
  return reference.set({ hour, minute, second: 0, millisecond: 0 })
}

export function evaluateAttendance(input: EvaluateAttendanceInput): AttendanceEvaluation {
  // El descanso gana sobre todo: venir en tu día libre no se castiga, y no venir tampoco.
  if (input.isDayOff) return none('DAY_OFF')

  // Sin cuadrante no hay contra qué comparar. Un negocio que aún no lo armó no debe ver a
  // toda su gente marcada como falta.
  if (!input.expectedStart || !input.expectedEnd) return none('NO_SCHEDULE')

  if (!input.clockInTime) return none('ABSENT')

  const localIn = DateTime.fromJSDate(input.clockInTime).setZone(input.timezone)
  const shouldStart = expectedMoment(localIn, input.expectedStart)
  const lateMinutes = Math.max(0, Math.round(localIn.diff(shouldStart, 'minutes').minutes))

  let earlyLeaveMinutes = 0
  if (input.clockOutTime) {
    const localOut = DateTime.fromJSDate(input.clockOutTime).setZone(input.timezone)
    // El fin se ancla al día de la ENTRADA: un turno que cruza la medianoche termina al día
    // siguiente, y anclarlo a la salida lo mediría contra el día equivocado.
    let shouldEnd = expectedMoment(localIn, input.expectedEnd)
    if (shouldEnd <= shouldStart) shouldEnd = shouldEnd.plus({ days: 1 })
    earlyLeaveMinutes = Math.max(0, Math.round(shouldEnd.diff(localOut, 'minutes').minutes))
  }

  return {
    status: lateMinutes > input.graceMinutes ? 'LATE' : 'ON_TIME',
    lateMinutes,
    earlyLeaveMinutes,
  }
}
