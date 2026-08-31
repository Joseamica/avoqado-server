/**
 * Fase 2 — ediciones del venue sobre eventos que Avoqado empujó.
 *
 * El pull descarta a propósito todo evento con `avoqadoOrigin = 'avoqado'`: es
 * el dedup que evita que nos bloqueemos a nosotros mismos. Pero ese mismo
 * descarte volvía INVISIBLES las ediciones que el venue hace sobre esos eventos
 * — estirar el bloque verde para que refleje lo que de verdad tardó, arrastrarlo
 * a otra hora. La reserva conservaba su ventana original y la disponibilidad
 * vendía el hueco (incidente `amaena`, 21-ago-2026).
 *
 * Este módulo decide, para un evento propio, si el venue lo movió de donde
 * Avoqado lo dejó y cuánta agenda hay que apartar por ello.
 *
 * Tres decisiones deliberadas:
 *
 *   1. **Sólo se aparta lo que SUMA.** Si el evento quedó contenido en lo que la
 *      reserva ya bloquea (lo acortaron), no se genera nada: la reserva manda
 *      sobre su propia ventana. Acortar en Google nunca libera agenda vendida.
 *   2. **El bloque cubre la ventana del EVENTO, no un excedente calculado.** Es
 *      idempotente y trivial de revertir: si el venue deshace su edición, la
 *      ventana vuelve a coincidir, esto devuelve `unchanged` y el bloque se
 *      retira solo.
 *   3. **Hay tope.** Una edición es ambigua — puede ser "duró más", "estoy
 *      tapando ese rato" o un arrastre accidental. Un dedo torcido que suelta el
 *      evento tres días después NO puede apagar la agenda de esos días: el
 *      bloque nunca pasa del fin del día natural en que empieza el evento.
 *
 * La reserva NUNCA se toca. Nada de two-way: mover un evento en Google no
 * reprograma al cliente ni dispara notificaciones.
 */
import { Prisma } from '@prisma/client'
import type { calendar_v3 } from 'googleapis'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

import logger from '@/config/logger'

/** Diferencias por debajo de esto son redondeos de Google, no una edición. */
export const OWN_EDIT_TOLERANCE_MS = 60_000

export interface OwnEventEditInput {
  eventStart: Date
  eventEnd: Date
  /** Inicio de la reserva/sesión que Avoqado empujó. */
  sourceStart: Date
  /** Fin del BLOQUE de agenda (ya incluye el buffer post-servicio). */
  sourceBlockedEnd: Date
  calendarTimeZone: string
}

export type OwnEventEditResult = { kind: 'unchanged' } | { kind: 'edited'; startsAt: Date; endsAt: Date }

const UNCHANGED: OwnEventEditResult = { kind: 'unchanged' }

function isValid(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime())
}

/**
 * Fin del día natural (23:59:59.999) del día en que ARRANCA el evento, en la
 * zona del calendario conectado. Es el tope del punto 3.
 */
function endOfCalendarDay(reference: Date, timeZone: string): Date {
  // Se compone la fecha como STRING y se resuelve en la zona del calendario:
  // un `new Date('YYYY-MM-DD')` pelón resolvería a medianoche del HOST, que en
  // producción es UTC (ver `.claude/rules/critical-warnings.md`).
  const local = toZonedTime(reference, timeZone)
  const y = local.getFullYear()
  const m = String(local.getMonth() + 1).padStart(2, '0')
  const d = String(local.getDate()).padStart(2, '0')
  return fromZonedTime(`${y}-${m}-${d}T23:59:59.999`, timeZone)
}

export function resolveOwnEventEdit(input: OwnEventEditInput): OwnEventEditResult {
  const { eventStart, eventEnd, sourceStart, sourceBlockedEnd, calendarTimeZone } = input

  // Un evento con fechas raras no puede tumbar el pull entero ni, peor, apagar
  // una agenda: se ignora.
  if (![eventStart, eventEnd, sourceStart, sourceBlockedEnd].every(isValid)) return UNCHANGED
  if (eventEnd.getTime() <= eventStart.getTime()) return UNCHANGED

  const startsEarlier = eventStart.getTime() < sourceStart.getTime() - OWN_EDIT_TOLERANCE_MS
  const endsLater = eventEnd.getTime() > sourceBlockedEnd.getTime() + OWN_EDIT_TOLERANCE_MS

  // Contenido en lo que la reserva ya bloquea ⇒ no aporta tiempo ocupado nuevo.
  if (!startsEarlier && !endsLater) return UNCHANGED

  let endsAt = eventEnd
  try {
    const cap = endOfCalendarDay(eventStart, calendarTimeZone)
    if (isValid(cap) && endsAt.getTime() > cap.getTime()) endsAt = cap
  } catch {
    // Zona horaria inválida en la conexión: se prefiere apartar sin tope antes
    // que no apartar nada. El tope es una salvaguarda, no un requisito.
  }

  if (endsAt.getTime() <= eventStart.getTime()) return UNCHANGED

  return { kind: 'edited', startsAt: eventStart, endsAt }
}

// ============================================================
// Aplicación contra la base
// ============================================================

/** Título del bloque. Se ve en el dashboard: el venue debe entender POR QUÉ está ocupado. */
export const OWN_EDIT_BLOCK_TITLE = 'Ajuste hecho en Google Calendar'

export interface ApplyOwnEventEditArgs {
  connectionId: string
  venueId: string | null
  staffId: string | null
  externalCalendarId: string
  calendarTimeZone: string
  event: calendar_v3.Schema$Event
}

/**
 * Punto único que llaman los tres caminos del pull (backfill, incremental y el
 * job de horizonte) al toparse con un evento propio.
 *
 * Es idempotente y auto-limpiante: si el evento vuelve a coincidir con la
 * reserva —porque el venue deshizo su edición, o porque la reserva se
 * reprogramó en Avoqado y el push la reposicionó— el bloque se borra.
 *
 * No lanza nunca: un fallo aquí no puede tumbar un pull que además trae
 * eventos externos legítimos.
 */
export async function applyOwnEventEdit(tx: Prisma.TransactionClient, args: ApplyOwnEventEditArgs): Promise<void> {
  const eventId = args.event.id
  if (!eventId) return

  const dropBlock = () =>
    tx.externalBusyBlock.deleteMany({
      where: { googleConnectionId: args.connectionId, externalEventId: eventId },
    })

  try {
    const mapping = await tx.reservationGoogleEventMapping.findUnique({
      where: { connectionId_googleEventId: { connectionId: args.connectionId, googleEventId: eventId } },
      select: {
        reservation: { select: { startsAt: true, endsAt: true, blockedEndsAt: true, status: true } },
        classSession: { select: { startsAt: true, endsAt: true, status: true } },
      },
    })

    // Evento propio sin reserva viva detrás (cancelada, borrada, o un evento de
    // otra instalación): nada contra qué comparar.
    const source = mapping?.reservation ?? mapping?.classSession
    if (!source) {
      await dropBlock()
      return
    }
    if (source.status === 'CANCELLED' || source.status === 'NO_SHOW') {
      await dropBlock()
      return
    }

    const sourceBlockedEnd = 'blockedEndsAt' in source ? (source.blockedEndsAt ?? source.endsAt) : source.endsAt

    const verdict = resolveOwnEventEdit({
      eventStart: parseEventBoundary(args.event.start),
      eventEnd: parseEventBoundary(args.event.end),
      sourceStart: source.startsAt,
      sourceBlockedEnd,
      calendarTimeZone: args.calendarTimeZone,
    })

    if (verdict.kind === 'unchanged') {
      await dropBlock()
      return
    }

    // ¿Es la PRIMERA vez que vemos esta edición? Sólo entonces se avisa: el
    // venue puede seguir moviendo el mismo evento y no queremos una notificación
    // por cada arrastre.
    const alreadyBlocked = await tx.externalBusyBlock.findUnique({
      where: { googleConnectionId_externalEventId: { googleConnectionId: args.connectionId, externalEventId: eventId } },
      select: { id: true },
    })

    await tx.externalBusyBlock.upsert({
      where: { googleConnectionId_externalEventId: { googleConnectionId: args.connectionId, externalEventId: eventId } },
      create: {
        googleConnectionId: args.connectionId,
        venueId: args.venueId,
        staffId: args.staffId,
        externalCalendarId: args.externalCalendarId,
        externalEventId: eventId,
        startsAt: verdict.startsAt,
        endsAt: verdict.endsAt,
        allDay: false,
        title: OWN_EDIT_BLOCK_TITLE,
        isPrivate: false,
      },
      update: { startsAt: verdict.startsAt, endsAt: verdict.endsAt, title: OWN_EDIT_BLOCK_TITLE, isPrivate: false },
    })

    logger.info('gcal: evento propio editado por el venue — agenda apartada', {
      connectionId: args.connectionId,
      googleEventId: eventId,
      startsAt: verdict.startsAt,
      endsAt: verdict.endsAt,
    })

    // Fire-and-forget FUERA de la transacción: avisar es importante, pero un
    // fallo del aviso no puede tumbar el pull ni deshacer el bloqueo.
    if (!alreadyBlocked && args.venueId) {
      void notifyVenueOfCalendarEdit({ venueId: args.venueId, startsAt: verdict.startsAt, endsAt: verdict.endsAt })
    }
  } catch (err) {
    logger.warn('gcal: no se pudo evaluar la edición de un evento propio', {
      connectionId: args.connectionId,
      googleEventId: eventId,
      err,
    })
  }
}

/** Fecha de un `start`/`end` de Google. Devuelve una fecha inválida si no hay nada usable. */
function parseEventBoundary(boundary: calendar_v3.Schema$EventDateTime | undefined): Date {
  if (boundary?.dateTime) return new Date(boundary.dateTime)
  if (boundary?.date) return new Date(`${boundary.date}T00:00:00Z`)
  return new Date(NaN)
}

/**
 * Avisa a OWNER/ADMIN del venue que su ajuste en Google apartó agenda.
 *
 * Es la mitad educativa del fix: sin este aviso, el negocio ve tiempo ocupado
 * que no bloqueó desde Avoqado y no entiende de dónde salió. El texto dice las
 * dos cosas que importan — que el ajuste NO reprogramó al cliente, y cómo
 * bloquear tiempo de la forma que sí es reversible.
 *
 * Nunca lanza: se llama con `void` desde fuera de la transacción.
 */
export async function notifyVenueOfCalendarEdit(args: { venueId: string; startsAt: Date; endsAt: Date }): Promise<void> {
  try {
    const { sendNotification } = await import('@/services/dashboard/notification.service')
    const prismaClient = (await import('@/utils/prismaClient')).default

    const recipients = await prismaClient.staffVenue.findMany({
      where: { venueId: args.venueId, active: true, role: { in: ['OWNER', 'ADMIN'] } },
      select: { staffId: true },
    })
    if (recipients.length === 0) return

    for (const recipient of recipients) {
      // try/catch POR destinatario: que el fallo de uno no deje sin aviso a los demás.
      try {
        await sendNotification({
          recipientId: recipient.staffId,
          venueId: args.venueId,
          type: 'CALENDAR_EVENT_EDITED',
          title: 'Ajustaste una cita desde Google Calendar',
          message:
            'Movimos ese horario a "ocupado" para que nadie reserve encima. Ojo: el ajuste NO reprogramó al cliente — su cita en Avoqado sigue igual. ' +
            'Si querías cambiarle la hora, hazlo desde Avoqado; si sólo querías tapar ese rato, crea un evento NUEVO en Google.',
          entityType: 'ExternalBusyBlock',
          priority: 'NORMAL',
        })
      } catch (err) {
        logger.warn('gcal: aviso de edición en Google falló para un destinatario', {
          venueId: args.venueId,
          staffId: recipient.staffId,
          err,
        })
      }
    }
  } catch (err) {
    logger.warn('gcal: no se pudo avisar al venue de su edición en Google', { venueId: args.venueId, err })
  }
}
