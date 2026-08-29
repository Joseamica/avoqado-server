import { DateTime } from 'luxon'

/**
 * Aviso EN VIVO de asistencia: "¿ya debería haber llegado y no ha llegado?".
 *
 * Hermano de `attendanceEvaluator.ts`, y la diferencia importa: aquél juzga un día YA ocurrido
 * (necesita la checada) y alimenta el reporte; éste corre mientras el día pasa, para avisar
 * cuando todavía se puede hacer algo — llamarle, mover a alguien, abrir con aviso.
 *
 * 🔴 Se comparte deliberadamente la convención de `lateMinutes`: minutos REALES de retraso, no
 * los que exceden la tolerancia. Si divergieran, el aviso de la mañana y el reporte de la tarde
 * dirían números distintos del mismo hecho.
 */

export type AvisoDeAsistencia = 'NINGUNO' | 'RETARDO'

export interface EvaluarAvisoInput {
  /** Hora de entrada esperada, "HH:mm" en hora del negocio. Null = sin cuadrante. */
  expectedStart: string | null
  /** Hora de salida esperada, "HH:mm" en hora del negocio. Null = sin cuadrante. */
  expectedEnd: string | null
  /** Zona del negocio (IANA). Obligatoria a propósito, igual que en el evaluador. */
  timezone: string
  /** Minutos de gracia antes de considerar tarde (`VenueSettings.attendanceGraceMinutes`). */
  graceMinutes: number
  /** La checada de entrada de hoy, si ya ocurrió. */
  clockInTime: Date | null
  /** Día del TURNO ('YYYY-MM-DD', calendario del negocio). Ancla la hora esperada. */
  scheduleDate: string
  /** Día de descanso: no se juzga. */
  isDayOff?: boolean
  /** El reloj, por parámetro: sin esto no se puede probar "20 minutos tarde". */
  now: Date
}

export interface EvaluacionDeAviso {
  aviso: AvisoDeAsistencia
  /** Minutos REALES de retraso al momento de evaluar. */
  minutosTarde: number
}

const sinAviso: EvaluacionDeAviso = { aviso: 'NINGUNO', minutosTarde: 0 }

/** "09:00" sobre el día dado, en la zona del negocio. */
function momentoEsperado(dia: DateTime, hhmm: string): DateTime {
  const [hora, minuto] = hhmm.split(':').map(Number)
  return dia.set({ hour: hora, minute: minuto, second: 0, millisecond: 0 })
}

export function evaluarAvisoEnVivo(input: EvaluarAvisoInput): EvaluacionDeAviso {
  // El descanso gana sobre todo, igual que en el evaluador.
  if (input.isDayOff) return sinAviso

  // Sin cuadrante no hay contra qué comparar. Un negocio que aún no armó horarios no puede
  // recibir un aviso por cada empleado cada mañana — es la vía rápida a que los ignore todos.
  if (!input.expectedStart || !input.expectedEnd) return sinAviso

  // Ya llegó. Si llegó tarde, eso lo cuenta el reporte: un aviso cuando la persona YA está
  // en el mostrador no le sirve a nadie y desgasta la credibilidad del resto.
  if (input.clockInTime) return sinAviso

  const dia = DateTime.fromISO(input.scheduleDate, { zone: input.timezone })
  if (!dia.isValid) return sinAviso

  const entrada = momentoEsperado(dia, input.expectedStart)
  // Un turno que cruza la medianoche termina al día siguiente. Sin esto, el nocturno
  // 22:00–06:00 se daría por terminado antes de haber empezado.
  let salida = momentoEsperado(dia, input.expectedEnd)
  if (salida <= entrada) salida = salida.plus({ days: 1 })

  const ahora = DateTime.fromJSDate(input.now).setZone(input.timezone)

  // 🔴 TOPE por arriba: pasada la hora de salida ya no es un retardo sino una falta, y la falta
  // la cuenta el reporte. Sin el tope, encender el sistema al día siguiente dispararía avisos
  // de ayer — la forma más rápida de que alguien deje de leerlos.
  if (ahora >= salida) return sinAviso

  const minutosTarde = Math.round(ahora.diff(entrada, 'minutes').minutes)
  if (minutosTarde <= input.graceMinutes) return sinAviso

  return { aviso: 'RETARDO', minutosTarde }
}
