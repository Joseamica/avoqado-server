/**
 * «Salida olvidada» — un turno sin salida se cierra solo (hz:f0a89d19:D3; founder 20-nov: «lo que tú decidas» → «A»).
 *
 * El caso que la originó: el checador dejaba abierto para siempre un turno sin salida (el cierre automático por hora fija o
 * por máximo de horas viene APAGADO). Al día siguiente la persona no podía entrar («ya tienes una entrada abierta») y su
 * siguiente salida cerraba el turno viejo con cientos de horas (Isaac Promotor: 267.42 h; antes 333, 647 y 999 h).
 *
 * Mercado (buscado en vivo el 20-nov, nota N-2f669760): Toast cierra solo al corte del día (04:00, de fábrica); Square a las
 * 24 h; Deputy a las 23 h con la SALIDA DE SU HORARIO; 7shifts a medianoche «sin aprobar»; Homebase «Missing clock out».
 * Ninguno deja un turno abierto por días.
 *
 * La regla, para TODOS los negocios y prendida de fábrica (`VenueSettings.salidaOlvidadaEnabled`, sin fila = prendida):
 *
 * 1. **Cuándo.** Un turno abierto es «olvidado» cuando pasa su LÍMITE: el siguiente corte del día de negocio (04:00 en la
 *    zona de la sucursal, el mismo de la caja: `BUSINESS_DAY_START_HOUR`) y nunca antes de [HORAS_MINIMAS] desde la entrada,
 *    para no partir un turno nocturno (antro de 22:00 a 06:00). Lo cierra el job cada 15 min o, si llega antes, la siguiente
 *    checada de la persona (entrada o salida, en cualquier aparato).
 * 2. **Con qué horas.** Si la persona tiene horario ese día (cuadrante, excepción o turno rotativo PUBLICADO: la misma
 *    precedencia que Asistencia, `resolveExpectedDay`), la salida es la de su horario, como Deputy. Si no, 0 horas
 *    (salida = entrada): en México no se inventan horas de nómina. Siempre queda «Salida olvidada · revisar»
 *    (`salidaOlvidada` + `autoClockOut`) para que el gerente la corrija.
 * 3. **La salida que llega tarde.** Una salida real del celular cuya hora cae DESPUÉS del límite no reemplaza un cierre
 *    automático (no estira el turno): se anota en la checada para el gerente. Una del mismo día (sin red) sí lo reemplaza.
 *    Ver `registrarSalidaDeCampo`.
 *
 * Toda escritura es condicional (`clockOutTime: null` en el WHERE): una salida real que gana la carrera nunca se pisa.
 */
import { Prisma, TimeEntryStatus } from '@prisma/client'
import { DateTime } from 'luxon'

import logger from '../../config/logger'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { resolveExpectedDay, type WeeklyWorkSchedule, type WorkScheduleException } from '../dashboard/workSchedule.service'
import { DEFAULT_TIMEZONE, isValidTimezone } from '../../utils/datetime'
import defaultPrisma from '../../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'
import { BUSINESS_DAY_START_HOUR } from './cashDrawerAutoClose'

/** Un turno nunca se da por olvidado antes de estas horas desde su entrada (turnos nocturnos que cruzan el corte). */
export const HORAS_MINIMAS = 12
/** Llegar hasta 4 h antes de la entrada de su horario todavía es ese turno. */
const LLEGADA_ANTICIPADA_MIN = 4 * 60
const MAX_HORAS = 999.99 // Decimal(5,2)
/** Por pasada del job: lo viejo se va cerrando en tandas, nunca una lectura sin tope. */
export const TOPE_POR_PASADA = 500
/** Páginas por pasada del job (cada 15 min): hasta 2,500 revisadas; lo demás, en la siguiente. */
const PAGINAS_POR_PASADA = 5

export const NOTA_SALIDA_OLVIDADA = '[Sistema] Salida olvidada · revisar'

type Db = Prisma.TransactionClient | typeof defaultPrisma

const zonaDe = (tz: string | null | undefined) => (tz && isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE)

/** Después de la salida de su horario, una hora de margen antes de darla por olvidada (Codex r1 #1: nocturnos largos). */
const MARGEN_TRAS_SU_HORARIO_MS = 60 * 60_000

/**
 * Hasta cuándo la entrada [clockIn] sigue siendo «su día»: el siguiente corte de las 04:00, nunca antes de 12 h y, si su
 * horario termina después (un nocturno de 21:00 a 10:00), hasta una hora después de su salida. Sin [finDeSuHorario] es el
 * límite BASE: el celular usa ése (no conoce el horario) y el job lo usa como filtro barato (el real nunca es menor).
 */
export function limiteDelTurno(clockIn: Date, timezone: string | null | undefined, finDeSuHorario?: Date | null): Date {
  const local = DateTime.fromJSDate(clockIn, { zone: zonaDe(timezone) })
  let corte = local.set({ hour: BUSINESS_DAY_START_HOUR, minute: 0, second: 0, millisecond: 0 })
  if (corte <= local) corte = corte.plus({ days: 1 })
  const base = Math.max(corte.toMillis(), clockIn.getTime() + HORAS_MINIMAS * 3_600_000)
  return new Date(finDeSuHorario ? Math.max(base, finDeSuHorario.getTime() + MARGEN_TRAS_SU_HORARIO_MS) : base)
}

export interface HorarioDelDia {
  /** 'YYYY-MM-DD' en el calendario del negocio. */
  fecha: string
  start: string | null
  end: string | null
}

/**
 * La salida de su horario para el turno que empezó en [clockIn], o null si no hay un horario que lo cubra (sin cuadrante,
 * día de descanso, o entró fuera de su horario). Se prueba el día de la entrada y el anterior (un nocturno de ayer que sigue a
 * las 00:30). Gana el horario que CONTIENE la entrada; si ninguno, el que empieza más pronto después de ella (llegó hasta 4 h
 * antes). Así una entrada de las 03:30 para cubrir el final del nocturno (22:00–06:00) no toma el diurno de las 07:00 (Codex
 * r1 #2). Sin [limite] no se acota (sirve para calcular el límite). Función pura.
 */
export function salidaDeSuHorario(
  clockIn: Date,
  timezone: string | null | undefined,
  dias: HorarioDelDia[],
  limite?: Date | null,
): Date | null {
  const zona = zonaDe(timezone)
  const t = clockIn.getTime()
  const turnos: { inicio: number; fin: number }[] = []
  for (const d of dias) {
    if (!d.start || !d.end) continue
    const base = DateTime.fromISO(d.fecha, { zone: zona })
    if (!base.isValid) continue
    const [hi, mi] = d.start.split(':').map(Number)
    const [hf, mf] = d.end.split(':').map(Number)
    const inicio = base.set({ hour: hi, minute: mi, second: 0, millisecond: 0 })
    let fin = base.set({ hour: hf, minute: mf, second: 0, millisecond: 0 })
    if (fin <= inicio) fin = fin.plus({ days: 1 })
    if (!inicio.isValid || !fin.isValid) continue
    turnos.push({ inicio: inicio.toMillis(), fin: fin.toMillis() })
  }
  const contiene = turnos.filter(x => x.inicio <= t && t < x.fin).sort((a, b) => b.inicio - a.inicio)[0]
  const anticipado = turnos
    .filter(x => t < x.inicio && t >= x.inicio - LLEGADA_ANTICIPADA_MIN * 60_000)
    .sort((a, b) => a.inicio - b.inicio)[0]
  const elegido = contiene ?? anticipado
  if (!elegido) return null
  return new Date(limite ? Math.min(elegido.fin, limite.getTime()) : elegido.fin)
}

/** Lo que hace falta leer de una checada abierta para decidir. */
const ENTRADA_SELECT = {
  id: true,
  staffId: true,
  venueId: true,
  clockInTime: true,
  status: true,
  notes: true,
  breaks: { select: { id: true, startTime: true, endTime: true } },
  venue: { select: { timezone: true, settings: { select: { salidaOlvidadaEnabled: true, rotatingShiftsEnabled: true } } } },
} satisfies Prisma.TimeEntrySelect

type EntradaAbierta = Prisma.TimeEntryGetPayload<{ select: typeof ENTRADA_SELECT }>

export type Disparador = 'JOB' | 'ENTRADA' | 'SALIDA' | 'IDENTIFICAR'

export interface SalidaOlvidadaCerrada {
  timeEntryId: string
  staffId: string
  venueId: string
  clockInTime: Date
  clockOutTime: Date
  totalHours: number
  /** HORARIO = salida de su horario · SIN_HORARIO = 0 horas hasta que el gerente corrija. */
  motivo: 'HORARIO' | 'SIN_HORARIO'
  disparador: Disparador
}

const ABIERTA = { in: [TimeEntryStatus.CLOCKED_IN, TimeEntryStatus.ON_BREAK] }

interface TurnoDeLaPersona {
  staffId: string
  venueId: string
  clockInTime: Date
  timezone: string | null | undefined
  rotativos: boolean
}

async function horarioDe(db: Db, e: TurnoDeLaPersona): Promise<HorarioDelDia[]> {
  const zona = zonaDe(e.timezone)
  const local = DateTime.fromJSDate(e.clockInTime, { zone: zona })
  const fechas = [local.toISODate(), local.minus({ days: 1 }).toISODate()].filter(Boolean) as string[]
  const rotativos = e.rotativos
  const sv = await db.staffVenue.findFirst({
    where: { staffId: e.staffId, venueId: e.venueId },
    select: {
      workSchedule: { select: { weekly: true } },
      workScheduleExceptions: {
        where: { startDate: { lte: fechas[0] }, endDate: { gte: fechas[fechas.length - 1] } },
        orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
        select: { startDate: true, endDate: true, kind: true, startTime: true, endTime: true, type: true },
        take: 50,
      },
      ...(rotativos
        ? {
            workShiftAssignments: {
              where: { date: { in: fechas }, status: 'PUBLISHED' },
              select: { date: true, startTime: true, endTime: true, status: true },
              take: 10,
            },
          }
        : {}),
    },
  })
  if (!sv) return []
  return fechas.map(fecha => {
    const asignacion = (
      sv as { workShiftAssignments?: { date: string; startTime: string; endTime: string; status: string }[] }
    ).workShiftAssignments?.find(a => a.date === fecha)
    const esperado = resolveExpectedDay(
      (sv.workSchedule?.weekly ?? null) as WeeklyWorkSchedule | null,
      sv.workScheduleExceptions as WorkScheduleException[],
      fecha,
      asignacion ?? null,
    )
    return { fecha, start: esperado.start, end: esperado.end }
  })
}

/**
 * El límite REAL de un turno (con la salida de su horario, que puede alargarlo) y esa salida. Lo usan el cierre, la regla de
 * la salida tardía del celular y la corrección del gerente: los tres miden igual.
 */
export async function limiteYSalidaDeSuHorario(db: Db, e: TurnoDeLaPersona): Promise<{ limite: Date; deSuHorario: Date | null }> {
  const fin = salidaDeSuHorario(e.clockInTime, e.timezone, await horarioDe(db, e))
  return { limite: limiteDelTurno(e.clockInTime, e.timezone, fin), deSuHorario: fin }
}

/**
 * El límite de un turno que YA cerró el sistema, fijo desde ese cierre (Codex r2 #3): el base, o una hora después de la salida
 * con la que se cerró (la de su horario). Cambiar el cuadrante después no lo mueve.
 */
export function limiteDeUnCierre(clockIn: Date, timezone: string | null | undefined, cierre: Date): Date {
  return limiteDelTurno(clockIn, timezone, cierre)
}

/** Cierra [e] como «salida olvidada» si ya pasó su límite y el negocio tiene la regla prendida. null = no tocó nada. */
async function cerrarSiOlvidada(db: Db, e: EntradaAbierta, ahora: Date, disparador: Disparador): Promise<SalidaOlvidadaCerrada | null> {
  if (e.venue.settings?.salidaOlvidadaEnabled === false) return null
  // Filtro barato: el límite real nunca es menor que el base, así que antes del base no hay nada que leer.
  if (ahora < limiteDelTurno(e.clockInTime, e.venue.timezone)) return null
  const { limite, deSuHorario } = await limiteYSalidaDeSuHorario(db, {
    staffId: e.staffId,
    venueId: e.venueId,
    clockInTime: e.clockInTime,
    timezone: e.venue.timezone,
    rotativos: e.venue.settings?.rotatingShiftsEnabled === true,
  })
  if (ahora < limite) return null // un nocturno largo con horario: todavía es su turno
  // El interruptor se relee dentro de la transacción (Codex r2 #11): el job leyó la página antes y el gerente pudo apagarla.
  const ajuste = await db.venueSettings.findUnique({ where: { venueId: e.venueId }, select: { salidaOlvidadaEnabled: true } })
  if (ajuste?.salidaOlvidadaEnabled === false) return null

  const salida = deSuHorario ?? e.clockInTime
  // Descansos: los terminados antes de la salida cuentan; uno abierto (o que pasa de la salida) termina en la salida.
  const descansos = e.breaks.map(b => {
    const fin = b.endTime === null || b.endTime > salida ? new Date(Math.max(b.startTime.getTime(), salida.getTime())) : b.endTime
    return { id: b.id, abierto: b.endTime === null, inicio: b.startTime, fin }
  })
  const minutosDescanso = descansos.reduce(
    (t, b) => t + Math.max(0, Math.min(b.fin.getTime(), salida.getTime()) - b.inicio.getTime()) / 60_000,
    0,
  )
  const minutos = (salida.getTime() - e.clockInTime.getTime()) / 60_000 - minutosDescanso
  const totalHours = deSuHorario ? Math.min(Math.max(0, Number((minutos / 60).toFixed(2))), MAX_HORAS) : 0
  const motivo = deSuHorario ? 'HORARIO' : 'SIN_HORARIO'
  const nota = deSuHorario
    ? `${NOTA_SALIDA_OLVIDADA}: no marcó salida; se cerró con la salida de su horario.`
    : `${NOTA_SALIDA_OLVIDADA}: no marcó salida y no tiene horario ese día; quedó en 0 horas hasta que el gerente la corrija.`

  const { count } = await db.timeEntry.updateMany({
    // También el estado leído (Codex r2 #12): un descanso que empezó después de leer cambia el estado y se relee después.
    where: { id: e.id, clockOutTime: null, status: e.status },
    data: {
      clockOutTime: salida,
      status: TimeEntryStatus.CLOCKED_OUT,
      totalHours,
      breakMinutes: deSuHorario ? Math.round(minutosDescanso) : 0,
      autoClockOut: true,
      salidaOlvidada: true,
      autoClockOutNote: nota,
    },
  })
  if (count !== 1) return null // una salida real ganó la carrera: es suya
  for (const b of descansos) {
    if (b.abierto) await db.timeEntryBreak.updateMany({ where: { id: b.id, endTime: null }, data: { endTime: b.fin } })
  }
  return {
    timeEntryId: e.id,
    staffId: e.staffId,
    venueId: e.venueId,
    clockInTime: e.clockInTime,
    clockOutTime: salida,
    totalHours,
    motivo,
    disparador,
  }
}

/**
 * Cierra los turnos olvidados de UNA persona (en cualquier sucursal) antes de su siguiente checada. Va dentro de la
 * transacción de la checada; la bitácora la escribe quien llama, al terminar ([anotarCierres]).
 */
export async function cerrarSalidasOlvidadasDe(
  db: Db,
  staffId: string,
  ahora: Date,
  disparador: Disparador,
): Promise<SalidaOlvidadaCerrada[]> {
  const abiertas = await db.timeEntry.findMany({
    where: { staffId, status: ABIERTA, clockOutTime: null, clockInTime: { lt: new Date(ahora.getTime() - HORAS_MINIMAS * 3_600_000) } },
    select: ENTRADA_SELECT,
    orderBy: { clockInTime: 'asc' },
    take: 20,
  })
  const cerradas: SalidaOlvidadaCerrada[] = []
  for (const e of abiertas) {
    const c = await cerrarSiOlvidada(db, e, ahora, disparador)
    if (c) cerradas.push(c)
  }
  return cerradas
}

/** Bitácora de cada cierre (fuera de la transacción: nunca la tumba). */
export function anotarCierres(cerradas: SalidaOlvidadaCerrada[]): void {
  for (const c of cerradas) {
    void logAction({
      staffId: null,
      venueId: c.venueId,
      action: 'TIME_ENTRY_FORGOTTEN_CLOCKOUT',
      entity: 'TimeEntry',
      entityId: c.timeEntryId,
      data: {
        personaStaffId: c.staffId,
        clockInTime: c.clockInTime.toISOString(),
        clockOutTime: c.clockOutTime.toISOString(),
        totalHours: c.totalHours,
        motivo: c.motivo,
        disparador: c.disparador,
      },
    })
  }
}

/** «9-nov» de la entrada, para decirle a la persona cuál se cerró. */
export function diaDeLaEntrada(clockIn: Date, timezone: string | null | undefined): string {
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
  const d = DateTime.fromJSDate(clockIn, { zone: zonaDe(timezone) })
  return `${d.day}-${MESES[d.month - 1]}`
}

/** El job: cierra en tandas los turnos olvidados de todos los negocios. Cada uno en su transacción. */
export async function cerrarSalidasOlvidadasPendientes(
  ahora = new Date(),
  db = defaultPrisma,
): Promise<{ cerradas: number; errores: number }> {
  // Sólo pueden haber pasado su límite las que tienen más de HORAS_MINIMAS: la lectura usa el índice de status. Se recorre
  // por páginas con cursor (Codex r1 #11): unas que todavía no vencen (otra zona, un nocturno largo) no tapan a las que sí.
  const where: Prisma.TimeEntryWhereInput = {
    status: ABIERTA,
    clockOutTime: null,
    clockInTime: { lt: new Date(ahora.getTime() - HORAS_MINIMAS * 3_600_000) },
    // Los negocios que la apagaron no ocupan la tanda (sin este filtro, 500 suyas taparían a todos los demás).
    venue: { OR: [{ settings: null }, { settings: { salidaOlvidadaEnabled: true } }] },
  }
  let cerradas = 0
  let errores = 0
  let revisadas = 0
  let cursor: string | undefined
  for (let pagina = 0; pagina < PAGINAS_POR_PASADA; pagina++) {
    const candidatas = await retry(
      () =>
        db.timeEntry.findMany({
          where,
          select: ENTRADA_SELECT,
          orderBy: [{ clockInTime: 'asc' }, { id: 'asc' }],
          take: TOPE_POR_PASADA,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'auto-clockout.salidasOlvidadas' },
    )
    revisadas += candidatas.length
    for (const e of candidatas) {
      // Sin transacción para las que ni el límite base han pasado (lo normal en una tanda de otra zona).
      if (ahora < limiteDelTurno(e.clockInTime, e.venue.timezone)) continue
      try {
        const c = await db.$transaction(tx => cerrarSiOlvidada(tx, e, ahora, 'JOB'))
        if (c) {
          cerradas++
          anotarCierres([c])
        }
      } catch (error) {
        errores++
        logger.error(`Salida olvidada: no se pudo cerrar la checada ${e.id}`, { venueId: e.venueId, error })
      }
    }
    if (candidatas.length < TOPE_POR_PASADA) break
    cursor = candidatas[candidatas.length - 1].id
  }
  if (cerradas > 0) logger.info(`Salida olvidada: ${cerradas} turnos cerrados`, { cerradas, errores, revisadas })
  return { cerradas, errores }
}

/**
 * Para el checador de la PAX y del POS (que buscan «la abierta» de la persona): cierra sus turnos olvidados en una
 * transacción propia ANTES de decidir entrada o salida, y anota la bitácora. Así un turno de ayer nunca contesta «ya
 * tienes entrada» ni se cierra con cientos de horas aunque el job todavía no pase.
 */
export async function cerrarOlvidadasAntesDeChecar(
  staffId: string,
  disparador: Disparador,
  ahora = new Date(),
): Promise<SalidaOlvidadaCerrada[]> {
  // Lo normal es que no haya nada viejo abierto: una lectura barata y sin transacción.
  const viejas = await defaultPrisma.timeEntry.findMany({
    where: { staffId, status: ABIERTA, clockOutTime: null, clockInTime: { lt: new Date(ahora.getTime() - HORAS_MINIMAS * 3_600_000) } },
    select: { id: true },
    take: 1,
  })
  if (!viejas?.length) return []
  const cerradas = await defaultPrisma.$transaction(tx => cerrarSalidasOlvidadasDe(tx, staffId, ahora, disparador))
  anotarCierres(cerradas)
  return cerradas
}

/** El texto para quien quiso marcar salida y su turno ya se había cerrado como «salida olvidada». */
export function textoSalidaYaOlvidada(c: SalidaOlvidadaCerrada, timezone: string | null | undefined): string {
  return `Tu entrada del ${diaDeLaEntrada(c.clockInTime, timezone)} se cerró como salida olvidada y la revisa tu gerente. Hoy no tienes entrada: marca tu entrada.`
}

/**
 * El gerente corrige una «Salida olvidada · revisar» desde Asistencia del DASHBOARD (`attendance:manage`). Sólo una
 * checada marcada; la salida va después de la entrada, no en el futuro, no después de su siguiente entrada y nunca
 * después de su límite (la regla no se usa para estirar un turno). Nadie corrige la suya. Se recalculan horas y
 * descansos, se quita la marca y queda en la bitácora con el antes y el después.
 */
export async function corregirSalidaOlvidada(params: {
  venueId: string
  timeEntryId: string
  clockOutTime: Date
  actorStaffId: string
  ahora?: Date
}): Promise<{ timeEntryId: string; clockOutTime: string; totalHours: number }> {
  const { venueId, timeEntryId, clockOutTime: salida, actorStaffId } = params
  const ahora = params.ahora ?? new Date()

  const resultado = await defaultPrisma.$transaction(async tx => {
    const dueno = await tx.timeEntry.findFirst({ where: { id: timeEntryId, venueId }, select: { staffId: true } })
    if (!dueno) throw new NotFoundError('No encontramos esa checada.', 'ENTRADA_NO_ENCONTRADA')
    // El mismo candado que la checada del celular (Codex r1 #7): una entrada que sube a la vez no se encima con esta salida.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`checada:${dueno.staffId}`}))::text`
    const e = await tx.timeEntry.findFirst({
      where: { id: timeEntryId, venueId },
      select: {
        id: true,
        staffId: true,
        venueId: true,
        clockInTime: true,
        clockOutTime: true,
        totalHours: true,
        salidaOlvidada: true,
        llaveSalida: true,
        notes: true,
        breaks: { select: { id: true, startTime: true, endTime: true } },
        venue: { select: { timezone: true, settings: { select: { rotatingShiftsEnabled: true } } } },
      },
    })
    if (!e) throw new NotFoundError('No encontramos esa checada.', 'ENTRADA_NO_ENCONTRADA')
    if (e.staffId === actorStaffId) {
      throw new ForbiddenError('No puedes corregir tu propia checada: tiene que hacerlo otra persona.', 'SELF_VALIDATION_FORBIDDEN')
    }
    if (!e.salidaOlvidada || !e.clockOutTime) {
      throw new ConflictError('Esta checada ya no está como «Salida olvidada».', 'NO_ES_SALIDA_OLVIDADA')
    }
    if (salida <= e.clockInTime) throw new BadRequestError('La salida tiene que ser después de la entrada.', 'SALIDA_ANTES_DE_ENTRADA')
    if (salida > ahora) throw new BadRequestError('La salida no puede estar en el futuro.', 'SALIDA_EN_EL_FUTURO')
    const { limite } = await limiteYSalidaDeSuHorario(tx, {
      staffId: e.staffId,
      venueId: e.venueId,
      clockInTime: e.clockInTime,
      timezone: e.venue.timezone,
      rotativos: e.venue.settings?.rotatingShiftsEnabled === true,
    })
    if (salida > limite) {
      throw new BadRequestError(
        `La salida no puede pasar de ${DateTime.fromJSDate(limite, { zone: zonaDe(e.venue.timezone) }).toFormat('HH:mm')} del día siguiente: un turno no dura días.`,
        'SALIDA_DESPUES_DEL_DIA',
      )
    }
    const siguiente = await tx.timeEntry.findFirst({
      where: { staffId: e.staffId, id: { not: e.id }, clockInTime: { gt: e.clockInTime, lt: salida } },
      select: { id: true },
    })
    if (siguiente) throw new ConflictError('Esa salida cae después de su siguiente entrada.', 'SALIDA_SE_ENCIMA')

    // Un descanso que terminó el SISTEMA al cerrar (a la hora del cierre, o en su propio inicio si el cierre fue en 0 h) sigue
    // abierto para la corrección: termina en la salida real (Codex r1 #12; antes, el descanso valía cero y sumaba horas).
    const cierre = e.clockOutTime
    const descansos = e.breaks.map(b => {
      const delSistema =
        b.endTime !== null &&
        (b.endTime.getTime() === cierre.getTime() || (b.endTime.getTime() === b.startTime.getTime() && b.startTime >= cierre))
      const cambia = b.endTime === null || b.endTime > salida || delSistema
      const fin = cambia ? new Date(Math.max(b.startTime.getTime(), salida.getTime())) : b.endTime!
      return { id: b.id, cambia, inicio: b.startTime, fin }
    })
    const minutosDescanso = descansos.reduce((t, b) => t + Math.max(0, b.fin.getTime() - b.inicio.getTime()) / 60_000, 0)
    const minutos = (salida.getTime() - e.clockInTime.getTime()) / 60_000 - minutosDescanso
    const totalHours = Math.min(Math.max(0, Number((minutos / 60).toFixed(2))), MAX_HORAS)
    const zona = zonaDe(e.venue.timezone)
    const fmt = (d: Date) => DateTime.fromJSDate(d, { zone: zona }).toFormat('HH:mm dd/MM')
    const anotacion = `Salida corregida por el gerente: ${fmt(salida)} (antes ${fmt(e.clockOutTime)}, salida olvidada).`

    const { count } = await tx.timeEntry.updateMany({
      // También la nota y la llave: si una salida tardía del celular se anotó después de leer, se relee (Codex r1 #6).
      where: { id: e.id, salidaOlvidada: true, clockOutTime: e.clockOutTime, notes: e.notes, llaveSalida: e.llaveSalida },
      data: {
        clockOutTime: salida,
        totalHours,
        breakMinutes: Math.round(minutosDescanso),
        salidaOlvidada: false,
        autoClockOut: false,
        editedBy: actorStaffId,
        notes: e.notes ? `${e.notes}\n${anotacion}` : anotacion,
      },
    })
    if (count !== 1) throw new ConflictError('La checada cambió mientras la corregías. Vuelve a abrirla.', 'CHECADA_EN_PROCESO')
    for (const b of descansos) if (b.cambia) await tx.timeEntryBreak.update({ where: { id: b.id }, data: { endTime: b.fin } })
    return {
      antes: { clockOutTime: e.clockOutTime.toISOString(), totalHours: Number(e.totalHours ?? 0) },
      despues: { clockOutTime: salida.toISOString(), totalHours },
      personaStaffId: e.staffId,
    }
  })

  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'TIME_ENTRY_FORGOTTEN_CLOCKOUT_CORRECTED',
    entity: 'TimeEntry',
    entityId: timeEntryId,
    data: resultado,
  })
  return { timeEntryId, clockOutTime: resultado.despues.clockOutTime, totalHours: resultado.despues.totalHours }
}

/**
 * La PAX o el POS mandan una salida y ya no hay turno abierto porque la regla lo acababa de cerrar (el job se adelantó
 * mientras la PAX esperaba el GPS, o el cierre perezoso de esta misma salida). La evidencia no se pierde (Codex r1 #8): la
 * foto y el voucher se pegan a esa checada si no tiene los suyos, y queda la nota con la hora real para el gerente. Sólo
 * una checada «Salida olvidada» de esta persona y sucursal cerrada en las últimas 2 h. null = no había ninguna.
 */
export async function anotarSalidaQueNoSeUso(params: {
  staffId: string
  venueId: string
  origen: 'PAX' | 'POS'
  checkOutPhotoUrl?: string | null
  depositPhotoUrl?: string | null
  skipReason?: string | null
  /** GPS de la salida que no se usó: en PlayTelecom es la prueba de que estuvo en su punto (FLAUTAS_C, 21-nov). */
  latitude?: number | null
  longitude?: number | null
  accuracy?: number | null
  ahora?: Date
}): Promise<string | null> {
  const ahora = params.ahora ?? new Date()
  const e = await defaultPrisma.timeEntry.findFirst({
    where: {
      staffId: params.staffId,
      venueId: params.venueId,
      salidaOlvidada: true,
      updatedAt: { gte: new Date(ahora.getTime() - 2 * 3_600_000) },
    },
    select: {
      id: true,
      clockInTime: true,
      clockOutTime: true,
      notes: true,
      checkOutPhotoUrl: true,
      depositPhotoUrl: true,
      clockOutLatitude: true,
      venue: { select: { timezone: true } },
    },
    orderBy: { clockInTime: 'desc' },
  })
  if (!e) return null
  const hora = DateTime.fromJSDate(ahora, { zone: zonaDe(e.venue.timezone) }).toFormat('HH:mm dd/MM')
  const anotacion = `Salida de la ${params.origen} a las ${hora}: llegó después del cierre de salida olvidada y no se usó. Revisa la hora real.`
  const { count } = await defaultPrisma.timeEntry.updateMany({
    where: { id: e.id, salidaOlvidada: true, notes: e.notes },
    data: {
      notes: e.notes ? `${e.notes}\n${anotacion}` : anotacion,
      ...(!e.checkOutPhotoUrl && params.checkOutPhotoUrl ? { checkOutPhotoUrl: params.checkOutPhotoUrl } : {}),
      ...(!e.depositPhotoUrl && params.depositPhotoUrl ? { depositPhotoUrl: params.depositPhotoUrl } : {}),
      ...(params.skipReason ? { checkoutSkipReason: params.skipReason } : {}),
      ...(e.clockOutLatitude == null && params.latitude != null && params.longitude != null
        ? { clockOutLatitude: params.latitude, clockOutLongitude: params.longitude, clockOutAccuracy: params.accuracy ?? null }
        : {}),
    },
  })
  const dia = diaDeLaEntrada(e.clockInTime, e.venue.timezone)
  // Codex r2 #5: sólo se dice «quedaron anotadas» si de verdad se escribió (otro escritor pudo cambiarla entre leer y escribir).
  if (count !== 1) {
    return `Tu entrada del ${dia} se cerró como salida olvidada y la revisa tu gerente. Tu salida no se pudo anotar: avísale. Si vas a trabajar, marca tu entrada.`
  }
  void logAction({
    staffId: params.staffId,
    venueId: params.venueId,
    action: 'TIME_ENTRY_LATE_CLOCKOUT_NOT_USED',
    entity: 'TimeEntry',
    entityId: e.id,
    data: {
      origen: params.origen,
      salidaRecibida: ahora.toISOString(),
      cierreAutomatico: e.clockOutTime?.toISOString() ?? null,
      gps: params.latitude != null && params.longitude != null ? { latitude: params.latitude, longitude: params.longitude } : null,
    },
  })
  return `Tu entrada del ${dia} se cerró como salida olvidada y la revisa tu gerente (tu salida y tus fotos quedaron anotadas). Si vas a trabajar, marca tu entrada.`
}
