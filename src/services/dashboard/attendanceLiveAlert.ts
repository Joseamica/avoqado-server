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

/**
 * Cuánto antes de su hora puede llegar alguien y que siga contando como ESTE turno. Llegar
 * temprano es normal; 6 h cubre incluso al que abre el local muy antes.
 */
const MARGEN_LLEGADA_TEMPRANA_HORAS = 6

/**
 * 🔴 Cuánto tiempo sigue teniendo sentido AVISAR de un retardo.
 *
 * P1 #3 de Codex (29-ago): no había tope por arriba más que la hora de salida, así que prender el
 * interruptor a las 16:30 sobre un turno 09:00–17:00 hacía que el siguiente tick avisara por TODOS
 * los ausentes del día, con cientos de minutos de retraso. Con 12 personas y 3 responsables son 36
 * correos de golpe — la forma más rápida de que alguien apague la función para siempre.
 *
 * Pasadas 2 horas ya no es una alerta: es una falta, y la falta la cuenta el reporte. Una alerta
 * existe para poder hacer algo —llamarle, mover a alguien a cubrir— y a las 4 horas ya no se puede.
 */
const VIGENCIA_DEL_AVISO_MINUTOS = 120

export interface VentanaDelTurno {
  expectedStart: string
  expectedEnd: string
  /** Día del TURNO ('YYYY-MM-DD' del negocio). */
  scheduleDate: string
  timezone: string
}

/**
 * 🔴 De todas las checadas de una persona, cuál pertenece a ESTE turno.
 *
 * P1 #1 de Codex (29-ago), reproducido contra la base antes de arreglarlo: la checada se buscaba
 * por PERSONA y el mismo valor servía para juzgar hoy y ayer, así que **la checada de ayer apagaba
 * el aviso de hoy**. Con casi todo el mundo trabajando el día anterior, el aviso no habría servido
 * para nadie.
 *
 * La ventana es `[entrada − 6 h, salida]`: hacia atrás para quien llega temprano, y hacia adelante
 * cortada en la salida porque después ya es otro turno — sin ese tope, un nocturno se daría por
 * cubierto con la entrada de la mañana siguiente, que es de otra persona-turno.
 */
export function checadaDelTurno(checadas: Date[], turno: VentanaDelTurno): Date | null {
  const dia = DateTime.fromISO(turno.scheduleDate, { zone: turno.timezone })
  if (!dia.isValid) return null

  const entrada = momentoEsperado(dia, turno.expectedStart)
  let salida = momentoEsperado(dia, turno.expectedEnd)
  if (salida <= entrada) salida = salida.plus({ days: 1 })
  const desde = entrada.minus({ hours: MARGEN_LLEGADA_TEMPRANA_HORAS })

  const dentro = checadas
    .filter(c => {
      const m = DateTime.fromJSDate(c).setZone(turno.timezone)
      return m >= desde && m <= salida
    })
    .sort((a, b) => a.getTime() - b.getTime())

  return dentro[0] ?? null
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

  // 🔴 Un aviso caduca: pasadas 2 h ya no es un retardo accionable sino una falta, y la falta la
  // cuenta el reporte. Sin esto, prender el interruptor por la tarde disparaba el día entero.
  if (minutosTarde > input.graceMinutes + VIGENCIA_DEL_AVISO_MINUTOS) return sinAviso

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
    select: {
      timezone: true,
      settings: { select: { attendanceEnabled: true, attendanceGraceMinutes: true, rotatingShiftsEnabled: true } },
    },
  })

  // 🔴 Con el checador APAGADO nadie puede checar, así que declarar tarde a todo el personal es
  // absurdo — y esta funcion la consume tambien la herramienta `who_is_late_now` del MCP, que NO
  // pasa por el filtro del job (P2 #4 de Codex). El job ya filtraba; el MCP no.
  if (venue?.settings?.attendanceEnabled === false) {
    return { venueId, ahora: DateTime.now().toISO() ?? '', tarde: [] }
  }
  // 🔴 Una zona nula o inválida NO cae a México en silencio (P2 #3 de Codex): un venue de
  // Tijuana o Cancún recibiría avisos corridos una o dos horas, y una zona basura produce un
  // DateTime inválido que deja el venue sin evaluar cada diez minutos sin que nadie lo sepa.
  const zona = venue?.timezone ?? ''
  if (!DateTime.local().setZone(zona).isValid) {
    throw new Error(`Zona horaria inválida o ausente en el venue ${venueId}: ${JSON.stringify(venue?.timezone)}`)
  }
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
  // TODAS las checadas por persona: cuál cuenta lo decide `checadaDelTurno` por TURNO, porque
  // la misma persona puede tener la de ayer y la de hoy en esta ventana.
  const checadasPorPersona = new Map<string, Date[]>()
  for (const c of checadas) {
    const lista = checadasPorPersona.get(c.staffId) ?? []
    lista.push(c.clockInTime)
    checadasPorPersona.set(c.staffId, lista)
  }

  const tarde: PersonaTarde[] = []
  for (const persona of personas) {
    for (const dia of dias) {
      const asignacion = (persona as any).workShiftAssignments?.find((a: any) => a.date === dia) ?? null
      const esperado = resolveExpectedDay(
        persona.workSchedule?.weekly as any,
        persona.workScheduleExceptions as any,
        dia,
        asignacion as any,
      )

      const veredicto = evaluarAvisoEnVivo({
        expectedStart: esperado.start,
        expectedEnd: esperado.end,
        timezone: zona,
        graceMinutes,
        clockInTime:
          esperado.start && esperado.end
            ? checadaDelTurno(checadasPorPersona.get(persona.staffId) ?? [], {
                expectedStart: esperado.start,
                expectedEnd: esperado.end,
                scheduleDate: dia,
                timezone: zona,
              })
            : null,
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
