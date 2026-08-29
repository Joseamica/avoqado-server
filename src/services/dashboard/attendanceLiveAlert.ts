import { DateTime } from 'luxon'
import prisma from '@/utils/prismaClient'
import { resolveExpectedDay } from './workSchedule.service'

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


// ─────────────────────────────────────────────────────────────────────────────
// Quién va tarde AHORA — la parte que toca la base
// ─────────────────────────────────────────────────────────────────────────────

export interface PersonaTarde {
  staffVenueId: string
  staffId: string
  nombre: string
  /** Día del TURNO al que pertenece el retardo ('YYYY-MM-DD' del negocio). */
  scheduleDate: string
  /** Hora de entrada esperada, "HH:mm". */
  esperada: string
  minutosTarde: number
}

/**
 * 🔴 UNA sola recolección para el job y para el MCP.
 *
 * Si el job y la herramienta que contesta "¿quién falta?" recolectaran por separado, acabarían
 * divergiendo — es exactamente el defecto que ya apareció entre el reporte de asistencia y las
 * comisiones con los turnos nocturnos, y que costó unificar después.
 *
 * NO decide si avisar ni a quién: sólo dice quién va tarde ahora mismo. El interruptor del aviso,
 * la deduplicación y los destinatarios viven en el job.
 */
export async function quienVaTarde(venueId: string, now: Date): Promise<{ venueId: string; ahora: string; tarde: PersonaTarde[] }> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true, settings: { select: { attendanceGraceMinutes: true, rotatingShiftsEnabled: true } } },
  })
  const zona = venue?.timezone || 'America/Mexico_City'
  const graceMinutes = venue?.settings?.attendanceGraceMinutes ?? 10
  const hoy = DateTime.fromJSDate(now).setZone(zona)
  // HOY y AYER: un turno nocturno de ayer sigue vivo a las 2 de la mañana.
  const dias = [hoy.toISODate(), hoy.minus({ days: 1 }).toISODate()].filter(Boolean) as string[]
  const ayer = dias[dias.length - 1]
  const hoyIso = dias[0]

  const personas = await prisma.staffVenue.findMany({
    where: { venueId, active: true, OR: [{ endDate: null }, { endDate: { gte: hoy.startOf('day').toJSDate() } }] },
    select: {
      id: true,
      staffId: true,
      staff: { select: { firstName: true, lastName: true } },
      workSchedule: { select: { weekly: true } },
      // 🔴 `workScheduleExceptions`, NO `scheduleExceptions`: ese último es la disponibilidad
      // para CITAS y reservas, otro modelo y otra cosa.
      workScheduleExceptions: {
        where: { startDate: { lte: hoyIso }, endDate: { gte: ayer } },
        orderBy: [{ startDate: 'asc' as const }, { createdAt: 'asc' as const }],
        select: { startDate: true, endDate: true, kind: true, startTime: true, endTime: true, type: true },
      },
      workShiftAssignments: venue?.settings?.rotatingShiftsEnabled
        ? { where: { date: { in: dias }, status: 'PUBLISHED' }, select: { date: true, startTime: true, endTime: true, status: true } }
        : (false as const),
    },
  })

  // Una sola pasada de checadas para todo el grupo: pedirlas por persona haría una consulta por fila.
  const desde = DateTime.fromISO(ayer, { zone: zona }).startOf('day').toJSDate()
  const checadas = await prisma.timeEntry.findMany({
    where: { venueId, staffId: { in: personas.map(p => p.staffId) }, clockInTime: { gte: desde } },
    select: { staffId: true, clockInTime: true },
    orderBy: { clockInTime: 'asc' },
  })
  const primeraChecada = new Map<string, Date>()
  for (const c of checadas) if (!primeraChecada.has(c.staffId)) primeraChecada.set(c.staffId, c.clockInTime)

  const tarde: PersonaTarde[] = []
  for (const persona of personas) {
    for (const dia of dias) {
      const asignacion = (persona as any).workShiftAssignments?.find((a: any) => a.date === dia) ?? null
      const esperado = resolveExpectedDay(persona.workSchedule?.weekly as any, persona.workScheduleExceptions as any, dia, asignacion as any)

      const veredicto = evaluarAvisoEnVivo({
        expectedStart: esperado.start,
        expectedEnd: esperado.end,
        timezone: zona,
        graceMinutes,
        clockInTime: primeraChecada.get(persona.staffId) ?? null,
        scheduleDate: dia,
        isDayOff: esperado.isDayOff,
        now,
      })
      if (veredicto.aviso !== 'RETARDO') continue

      tarde.push({
        staffVenueId: persona.id,
        staffId: persona.staffId,
        nombre: `${persona.staff.firstName ?? ''} ${persona.staff.lastName ?? ''}`.trim() || 'Sin nombre',
        scheduleDate: dia,
        esperada: esperado.start as string,
        minutosTarde: veredicto.minutosTarde,
      })
    }
  }

  return { venueId, ahora: hoy.toISO() ?? '', tarde }
}
