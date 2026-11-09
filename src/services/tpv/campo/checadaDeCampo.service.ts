/**
 * La checada del celular del promotor (App de campo, bloque 0, Tarea 6).
 *
 * El celular guarda la checada con una llave (UUID) y su hora, y la sube cuando hay señal. La persona sale del token: no
 * hay PIN. La salida NOMBRA su entrada (`timeEntryId` o `llaveEntrada`), nunca busca «la abierta». Entrada y salida van
 * en una transacción con el candado de la persona (`pg_advisory_xact_lock`), así que dos subidas de la misma persona se
 * forman en fila. Si el cierre automático ya cerró la entrada, la salida real lo reemplaza y queda en la bitácora; si la
 * cerró una persona, se rechaza. Plan: docs/superpowers/plans/2026-11-08-app-de-campo-bloque-0-tuberia.md.
 */
import { Prisma, TimeEntryStatus } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { BadRequestError, ConflictError, NotFoundError, ValidationError } from '@/errors/AppError'
import type { EntradaDeCampoBody, SalidaDeCampoBody } from '@/schemas/tpv/campo.schema'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertAttendanceEnabled } from '@/services/dashboard/attendanceGate'
import prisma from '@/utils/prismaClient'
import { resolverHoraDelCelular } from './horaDelCelular'

/** La sucursal de la dirección y la persona del token. */
interface Quien {
  venueId: string
  staffId: string
}

const MAX_HORAS = 999.99 // Decimal(5,2), igual que `time-entry.tpv.service.ts`
const INTENTOS = 3 // la escritura condicional sólo pierde contra otro escritor que no toma el candado (PAX o el cierre automático)

const candado = (tx: Prisma.TransactionClient, staffId: string) =>
  tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`checada:${staffId}`}))::text`

const horaDe = (v: { ocurrioAt?: string; origenHora?: 'RELOJ_ANCLADO' | 'RELOJ_DEL_CELULAR' }, ahora: Date) =>
  resolverHoraDelCelular({ ocurrioAt: v.ocurrioAt ? new Date(v.ocurrioAt) : undefined, origen: v.origenHora }, ahora)

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
/** «03:00 del 4-nov (America/Mexico_City)»; con una zona que no existe, la hora en ISO (la salida no se pierde por la nota). */
function enLaZona(d: Date, zona: string) {
  try {
    const [hhmm, dia, mes] = formatInTimeZone(d, zona, 'HH:mm|d|M').split('|')
    return `${hhmm} del ${dia}-${MESES[Number(mes) - 1]} (${zona})`
  } catch {
    return d.toISOString()
  }
}

/** POST …/checadas/entrada. */
export async function registrarEntradaDeCampo(q: Quien, v: EntradaDeCampoBody, ahora = new Date()) {
  const { hora, origen } = horaDe(v, ahora)
  return prisma.$transaction(async tx => {
    await candado(tx, q.staffId)

    const misma = await tx.timeEntry.findUnique({
      where: { staffId_llaveEntrada: { staffId: q.staffId, llaveEntrada: v.llave } },
      select: { id: true, clockInTime: true },
    })
    if (misma) return { timeEntryId: misma.id, repetida: true, hora: misma.clockInTime.toISOString() }

    // De cualquier escritor (PAX, POS, celular) y en cualquier sucursal: una persona no está en dos lados a la vez.
    const abierta = await tx.timeEntry.findFirst({
      where: { staffId: q.staffId, status: { in: [TimeEntryStatus.CLOCKED_IN, TimeEntryStatus.ON_BREAK] } },
      select: { id: true, venueId: true, clockInTime: true },
      orderBy: { clockInTime: 'desc' },
    })
    if (abierta) {
      throw new ConflictError('Ya tienes una entrada abierta. Primero marca la salida.', 'YA_TIENE_ENTRADA', {
        timeEntryId: abierta.id,
        venueId: abierta.venueId,
        clockInTime: abierta.clockInTime.toISOString(),
      })
    }

    // Un turno ya cerrado que termina después de esta hora: la entrada caería dentro de él (horas contadas dos veces).
    const encimada = await tx.timeEntry.findFirst({
      where: { staffId: q.staffId, clockOutTime: { gt: hora } },
      select: { id: true, venueId: true, clockInTime: true, clockOutTime: true },
      orderBy: { clockOutTime: 'desc' },
    })
    if (encimada) {
      throw new ConflictError('Esta entrada cae dentro de un turno que ya registraste.', 'ENTRADA_SE_ENCIMA', {
        timeEntryId: encimada.id,
        venueId: encimada.venueId,
        clockInTime: encimada.clockInTime.toISOString(),
        clockOutTime: encimada.clockOutTime!.toISOString(),
      })
    }

    await assertAttendanceEnabled(q.venueId)

    const creada = await tx.timeEntry.create({
      data: {
        staffId: q.staffId,
        venueId: q.venueId,
        clockInTime: hora,
        status: TimeEntryStatus.CLOCKED_IN,
        breakMinutes: 0,
        llaveEntrada: v.llave,
        clockInOrigenHora: origen,
        clockInUbicacionFalsa: v.ubicacionFalsa,
        clockInLatitude: v.latitude,
        clockInLongitude: v.longitude,
        clockInAccuracy: v.accuracy,
        checkInPhotoUrl: v.checkInPhotoUrl,
        facadePhotoUrl: v.facadePhotoUrl,
      },
      select: { id: true },
    })
    return { timeEntryId: creada.id, repetida: false, hora: hora.toISOString() }
  })
}

/** POST …/checadas/salida. */
export async function registrarSalidaDeCampo(q: Quien, v: SalidaDeCampoBody, ahora = new Date()) {
  // Nunca se busca «la de la persona en la sucursal»: sin nombre de entrada, no hay salida.
  if (!v.timeEntryId === !v.llaveEntrada) {
    throw new BadRequestError('La salida nombra su entrada: manda timeEntryId o llaveEntrada, sólo uno.', 'SALIDA_SIN_ENTRADA')
  }
  const { hora, origen } = horaDe(v, ahora)
  const { resultado, reemplazo } = await prisma.$transaction(async tx => {
    await candado(tx, q.staffId)

    const misma = await tx.timeEntry.findUnique({
      where: { staffId_llaveSalida: { staffId: q.staffId, llaveSalida: v.llave } },
      select: { id: true, clockOutTime: true, totalHours: true },
    })
    if (misma) {
      const resultado = {
        timeEntryId: misma.id,
        repetida: true,
        hora: misma.clockOutTime?.toISOString() ?? null,
        totalHours: Number(misma.totalHours),
      }
      return { resultado, reemplazo: null }
    }

    for (let intento = 0; intento < INTENTOS; intento++) {
      const e = await tx.timeEntry.findFirst({
        where: { staffId: q.staffId, venueId: q.venueId, ...(v.timeEntryId ? { id: v.timeEntryId } : { llaveEntrada: v.llaveEntrada }) },
        select: {
          id: true,
          clockInTime: true,
          clockOutTime: true,
          autoClockOut: true,
          status: true,
          validationStatus: true,
          totalHours: true,
          notes: true,
          breaks: { select: { id: true, startTime: true, endTime: true } },
        },
      })
      if (!e) throw new NotFoundError('No encontramos esa entrada.', 'ENTRADA_NO_ENCONTRADA')
      if (hora < e.clockInTime) throw new ValidationError('La salida es antes que la entrada.', 'SALIDA_ANTES_DE_ENTRADA')
      const cierreAutomatico = e.clockOutTime
      if (cierreAutomatico && !e.autoClockOut) throw new ConflictError('Esta entrada ya tiene salida.', 'YA_TIENE_SALIDA')
      // Una entrada posterior de la persona que empezó antes de esta salida: el turno se encimaría con ella.
      const siguiente = await tx.timeEntry.findFirst({
        where: { staffId: q.staffId, clockInTime: { gt: e.clockInTime, lt: hora } },
        select: { id: true, venueId: true, clockInTime: true },
        orderBy: { clockInTime: 'asc' },
      })
      if (siguiente) {
        throw new ConflictError('Esta salida cae después de una entrada que ya registraste.', 'SALIDA_SE_ENCIMA', {
          timeEntryId: siguiente.id,
          venueId: siguiente.venueId,
          clockInTime: siguiente.clockInTime.toISOString(),
        })
      }

      // Un descanso abierto, que termina después de la salida o que terminó el sistema (el job usa la misma hora para el
      // descanso y para el cierre) termina a la hora de la salida. Los que terminó una persona antes no se tocan.
      const descansos = e.breaks.map(b => {
        const cambia =
          b.endTime === null || b.endTime > hora || (cierreAutomatico !== null && b.endTime.getTime() === cierreAutomatico.getTime())
        return { ...b, cambia, endTime: cambia ? new Date(Math.max(b.startTime.getTime(), hora.getTime())) : b.endTime! }
      })
      const minutosDeDescanso = descansos.reduce((t, b) => t + (b.endTime.getTime() - b.startTime.getTime()) / 60_000, 0)
      const minutos = (hora.getTime() - e.clockInTime.getTime()) / 60_000 - minutosDeDescanso
      const totalHours = Math.min(Math.max(0, Number((minutos / 60).toFixed(2))), MAX_HORAS)
      let nota: string | null = null
      if (cierreAutomatico) {
        const venue = await tx.venue.findUnique({ where: { id: q.venueId }, select: { timezone: true } })
        nota = `Salida real del celular; reemplazó el cierre automático de ${enLaZona(cierreAutomatico, venue?.timezone ?? 'America/Mexico_City')}`
      }

      const { count } = await tx.timeEntry.updateMany({
        // Todo lo que se leyó para decidir: si otro escritor lo cambió (la PAX abrió un descanso, el job la cerró, un
        // supervisor la aprobó), 0 filas y se relee.
        where: {
          id: e.id,
          clockOutTime: e.clockOutTime,
          autoClockOut: e.autoClockOut,
          status: e.status,
          validationStatus: e.validationStatus,
        },
        data: {
          clockOutTime: hora,
          status: TimeEntryStatus.CLOCKED_OUT,
          totalHours,
          breakMinutes: Math.round(minutosDeDescanso),
          llaveSalida: v.llave,
          clockOutRecibidaAt: ahora,
          clockOutOrigenHora: origen,
          clockOutUbicacionFalsa: v.ubicacionFalsa,
          clockOutLatitude: v.latitude,
          clockOutLongitude: v.longitude,
          clockOutAccuracy: v.accuracy,
          checkOutPhotoUrl: v.checkOutPhotoUrl,
          ...(nota && { autoClockOut: false, notes: e.notes ? `${e.notes}\n${nota}` : nota }),
        },
      })
      if (count === 0) continue // otro escritor la cambió entre la lectura y la escritura: se relee y se decide otra vez

      // Después de ganar la escritura condicional: la fila de la entrada queda bloqueada hasta el commit.
      for (const b of descansos) {
        if (b.cambia) await tx.timeEntryBreak.update({ where: { id: b.id }, data: { endTime: b.endTime } })
      }
      return {
        resultado: { timeEntryId: e.id, repetida: false, hora: hora.toISOString(), totalHours },
        reemplazo: cierreAutomatico && {
          cierreAutomatico,
          // La validación no se toca (regresarla a PENDIENTE dejaba vivo el depósito de la aprobación y aprobar otra vez
          // lo duplicaba): la bitácora dice con qué estado estaba y cómo cambiaron las horas, para el supervisor.
          validacionAnterior: e.validationStatus,
          horasAntes: Number(e.totalHours),
        },
      }
    }
    throw new ConflictError('La entrada cambió mientras se guardaba la salida. Reintenta.', 'CHECADA_EN_PROCESO')
  })

  if (reemplazo) {
    await logAction({
      staffId: q.staffId,
      venueId: q.venueId,
      action: 'TIME_ENTRY_AUTO_CLOCKOUT_REPLACED',
      entity: 'TimeEntry',
      entityId: resultado.timeEntryId,
      data: {
        ...reemplazo,
        cierreAutomatico: reemplazo.cierreAutomatico.toISOString(),
        salidaReal: resultado.hora,
        origenHora: origen,
        llaveSalida: v.llave,
        horasDespues: resultado.totalHours,
      },
    })
  }
  return resultado
}
