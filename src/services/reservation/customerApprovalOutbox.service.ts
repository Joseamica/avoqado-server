/**
 * Fase 1 — outbox de avisos de aprobación de clientes.
 *
 * Por qué un outbox y no un `await sendEmail()` donde se decide: el correo se manda DESPUÉS
 * del commit, pero la intención de mandarlo se graba DENTRO de la transacción. Si la
 * decisión se revierte, nadie recibe nada; si el proceso muere después del commit, el aviso
 * sigue en la tabla y sale al siguiente tick.
 *
 * 🔴 La unidad de entrega es **(evento × destinatario × canal)**, no el evento. Un evento con
 * tres destinatarios que entrega a dos y falla en el tercero, al reintentar le volvería a
 * escribir a los dos primeros si el dedupe fuera sólo por evento. Por eso hay dos tablas:
 * `CustomerApprovalOutbox` (el hecho) y `CustomerApprovalDelivery` (una fila por destinatario).
 *
 * Este archivo contiene el NÚCLEO PURO —sin base de datos, sin red, con el reloj por
 * parámetro— para que toda la corrección se pueda probar sola. La entrega vive en el job.
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'

export type ApprovalOutboxEvent = 'REQUESTED_STAFF' | 'PENDING_CUSTOMER' | 'APPROVED_CUSTOMER' | 'REJECTED_CUSTOMER'
export type DeliveryChannel = 'EMAIL' | 'WHATSAPP'
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'DEAD_LETTER'

/**
 * Seis intentos con backoff exponencial cubren ~2 horas de caída del proveedor. Más que eso
 * no es persistencia, es ruido: si Resend lleva dos horas caído, el correo perdió su valor
 * de "avísale a la dueña" y lo que hace falta es que alguien VEA el `DEAD_LETTER`.
 */
export const MAX_DELIVERY_ATTEMPTS = 6

const BASE_DELAY_MS = 60_000
const MAX_DELAY_MS = 3_600_000
const MAX_ERROR_CHARS = 1_000

/**
 * Backoff exponencial con techo de una hora. El techo importa: sin él, el intento 20 caería
 * dentro de tres semanas y la fila quedaría viva pero muerta.
 */
export function nextAttemptDelayMs(attempts: number): number {
  const safeAttempts = Math.max(1, Math.floor(attempts))
  const raw = BASE_DELAY_MS * 2 ** (safeAttempts - 1)
  return Math.min(MAX_DELAY_MS, raw)
}

/**
 * Qué hacer con una entrega que acaba de fallar. `attempts` es el número de intentos YA
 * realizados, incluido el que falló.
 */
export function resolveDeliveryOutcome(input: { attempts: number; now: Date; error: string }): {
  status: Extract<DeliveryStatus, 'FAILED' | 'DEAD_LETTER'>
  nextAttemptAt: Date | null
  lastError: string
} {
  const lastError = input.error.slice(0, MAX_ERROR_CHARS)

  if (input.attempts >= MAX_DELIVERY_ATTEMPTS) {
    // Se deja de reintentar A PROPÓSITO. Reintentar para siempre esconde el problema: la
    // fila en DEAD_LETTER con su `lastError` es lo que alguien puede ver y arreglar.
    return { status: 'DEAD_LETTER', nextAttemptAt: null, lastError }
  }

  return {
    status: 'FAILED',
    nextAttemptAt: new Date(input.now.getTime() + nextAttemptDelayMs(input.attempts)),
    lastError,
  }
}

type StaffRecipient = { id: string; email: string | null; role: string }
type CustomerRecipient = { id: string; email: string | null; phone: string | null }

/**
 * A quién le toca cada evento.
 *
 * - `REQUESTED_STAFF` → al staff del negocio cuyos roles estén en `notifyRoles`.
 * - los otros tres → al CLIENTE.
 *
 * Devolver una lista vacía es un resultado válido, no un error: un negocio que no configuró
 * roles de aviso se queda sin correo, pero la cuenta ya quedó registrada y visible en la
 * bandeja "en espera". Fallar aquí bloquearía un registro por no poder avisar de él.
 */
export function recipientsForEvent(
  event: ApprovalOutboxEvent,
  ctx: { staff: StaffRecipient[]; customer: CustomerRecipient; notifyRoles: string[] },
): { recipient: string; channel: DeliveryChannel }[] {
  if (event === 'REQUESTED_STAFF') {
    const roles = new Set(ctx.notifyRoles)
    const seen = new Set<string>()
    const out: { recipient: string; channel: DeliveryChannel }[] = []

    for (const s of ctx.staff) {
      if (!roles.has(s.role) || !s.email) continue
      // La misma persona puede aparecer con dos roles configurados: un correo, no dos.
      if (seen.has(s.email)) continue
      seen.add(s.email)
      out.push({ recipient: s.email, channel: 'EMAIL' })
    }
    return out
  }

  if (!ctx.customer.email) return []
  return [{ recipient: ctx.customer.email, channel: 'EMAIL' }]
}

/**
 * `${event}:${customerId}:${approvalVersion}`.
 *
 * La versión es lo que hace que APROBADO→RECHAZADO→APROBADO sí mande dos correos de
 * aprobación (hubo un rechazo real en medio y la versión subió), mientras que repetir la
 * MISMA decisión no manda nada (no sube la versión).
 */
export function dedupeKey(event: ApprovalOutboxEvent, customerId: string, approvalVersion: number): string {
  return `${event}:${customerId}:${approvalVersion}`
}

/**
 * Clave de idempotencia que viaja al proveedor de correo. Si el proceso muere entre "Resend
 * aceptó" y el `sentAt` en la base, el reintento NO genera un segundo correo.
 */
export function providerKeyFor(outboxId: string, recipient: string, channel: DeliveryChannel): string {
  return `${outboxId}:${channel}:${recipient}`
}

// ============================================================================
// Worker — abanico de destinatarios y entrega. Todo lo de aquí toca la base.
// ============================================================================

const CLAIM_LEASE_MS = 30_000
const DEFAULT_LIMIT = 100

function bookingUrlFor(slug: string): string {
  return `${process.env.BOOKING_PUBLIC_URL || 'https://book.avoqado.io'}/${slug}`
}

function dashboardInboxUrlFor(slug: string): string {
  return `${process.env.FRONTEND_URL || 'https://dashboard.avoqado.io'}/venues/${slug}/clientes?estado=en-espera`
}

/**
 * Abre cada evento nuevo en una fila por destinatario.
 *
 * Va SEPARADO de la entrega a propósito: los destinatarios se resuelven al momento de
 * expandir, no al encolar. Si se resolvieran dentro de la transacción que aprueba, esa
 * transacción tendría que consultar el staff del venue — trabajo ajeno a la decisión y que
 * la haría fallar por algo que no tiene nada que ver.
 */
export async function expandPendingEvents(input: { limit?: number; now: Date }): Promise<{ expanded: number; events: number }> {
  const limit = Math.max(1, Math.min(DEFAULT_LIMIT, input.limit ?? DEFAULT_LIMIT))

  const events = await prisma.customerApprovalOutbox.findMany({
    where: { deliveries: { none: {} } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: {
      venue: { select: { id: true, name: true, slug: true } },
      customer: { select: { id: true, email: true, phone: true, firstName: true, lastName: true } },
    },
  })

  let expanded = 0

  for (const ev of events) {
    let staff: StaffRecipient[] = []
    let notifyRoles: string[] = []

    if (ev.event === 'REQUESTED_STAFF') {
      const settings = await prisma.reservationSettings.findUnique({
        where: { venueId: ev.venueId },
        select: { customerApprovalNotificationRoles: true },
      })
      notifyRoles = (settings?.customerApprovalNotificationRoles ?? []) as unknown as string[]

      // 🔴 Los DOS filtros de activo. `StaffVenue.active` solo deja pasar a alguien dado de
      // baja de la plataforma que aún conserva el vínculo con el venue; `Staff.active` solo,
      // a alguien que ya no trabaja en ESTE negocio. Hacen falta los dos.
      const rows = await prisma.staffVenue.findMany({
        where: { venueId: ev.venueId, active: true, staff: { active: true }, role: { in: notifyRoles as never[] } },
        select: { role: true, staff: { select: { id: true, email: true } } },
      })
      staff = rows.map(r => ({ id: r.staff.id, email: r.staff.email, role: String(r.role) }))
    }

    const recipients = recipientsForEvent(ev.event as ApprovalOutboxEvent, {
      staff,
      customer: { id: ev.customer.id, email: ev.customer.email, phone: ev.customer.phone },
      notifyRoles,
    })

    if (recipients.length === 0) {
      // Sin destinatarios no hay nada que entregar — pero si no se marca, este evento vuelve
      // a leerse en CADA tick para siempre. Se cierra con una fila centinela: el evento queda
      // con historia (se ve por qué no salió nada) y deja de aparecer en la cola.
      await prisma.customerApprovalDelivery.create({
        data: {
          outboxId: ev.id,
          recipient: '',
          channel: 'EMAIL',
          providerKey: providerKeyFor(ev.id, '', 'EMAIL'),
          status: 'SUPERSEDED',
          lastError: 'SIN_DESTINATARIOS',
        },
      })
      continue
    }

    const created = await prisma.customerApprovalDelivery.createMany({
      skipDuplicates: true, // reexpandir el mismo evento no puede duplicar correos
      data: recipients.map(r => ({
        outboxId: ev.id,
        recipient: r.recipient,
        channel: r.channel,
        providerKey: providerKeyFor(ev.id, r.recipient, r.channel),
      })),
    })
    expanded += created.count
  }

  return { expanded, events: events.length }
}

type ClaimedDelivery = {
  id: string
  outboxId: string
  recipient: string
  channel: DeliveryChannel
  providerKey: string
  attempts: number
  leaseUntil: Date | null
  outbox: {
    event: string
    customerId: string
    approvalVersion: number
    venue: { name: string; slug: string }
    customer: { firstName: string | null; lastName: string | null }
  }
  reason?: string | null
}

/**
 * Reclama entregas listas con `FOR UPDATE SKIP LOCKED`: dos workers nunca se llevan la misma
 * fila. `attempts` se incrementa AQUÍ, no al fallar — si el proceso muere a media entrega, el
 * intento ya está contado y la fila no puede reintentarse infinitamente.
 */
export async function claimDeliveries(input: { limit?: number; now: Date }): Promise<string[]> {
  const limit = Math.max(1, Math.min(DEFAULT_LIMIT, input.limit ?? DEFAULT_LIMIT))
  const now = input.now
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS)
  // Las columnas DateTime de este schema son `timestamp without time zone`: un Date crudo
  // viaja como timestamptz y se corre en sesiones de DB que no estén en UTC.
  const nowSql = Prisma.sql`${now.toISOString()}::timestamp`
  const leaseSql = Prisma.sql`${leaseUntil.toISOString()}::timestamp`

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH candidates AS (
      SELECT d.id
      FROM "CustomerApprovalDelivery" AS d
      WHERE d.status IN ('PENDING', 'FAILED')
        AND d."nextAttemptAt" <= ${nowSql}
        AND (d."leaseUntil" IS NULL OR d."leaseUntil" <= ${nowSql})
      ORDER BY d."nextAttemptAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "CustomerApprovalDelivery" AS d
    SET "leaseUntil" = ${leaseSql}, attempts = d.attempts + 1, "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE d.id = candidates.id
    RETURNING d.id
  `)

  return rows.map(r => r.id)
}

/**
 * Entrega las filas reclamadas.
 *
 * Dos cosas que cuestan caro si se olvidan:
 *
 * 1. **`sendEmail` devuelve `false` en vez de lanzar** cuando Resend rechaza o falta la API
 *    key. Tratar eso como éxito marcaría SENT un correo que nunca salió.
 * 2. **Supresión por versión**: si ya salió un aviso más NUEVO del mismo cliente, éste no se
 *    manda. Sin eso, "tu cuenta está en revisión" puede llegar después de "ya puedes
 *    reservar" y el cliente no entiende nada.
 */
export async function deliverClaimed(
  claimed: ClaimedDelivery[],
  opts: { now: Date },
): Promise<{ sent: number; failed: number; superseded: number }> {
  let sent = 0
  let failed = 0
  let superseded = 0

  for (const d of claimed) {
    // El CAS: sólo se acepta el resultado si la fila sigue siendo la que reclamamos.
    const casWhere = { id: d.id, attempts: d.attempts, leaseUntil: d.leaseUntil }

    try {
      const newerSent = await prisma.customerApprovalDelivery.count({
        where: {
          status: 'SENT',
          outbox: { customerId: d.outbox.customerId, approvalVersion: { gt: d.outbox.approvalVersion } },
        },
      })

      if (newerSent > 0) {
        superseded += 1
        await prisma.customerApprovalDelivery.updateMany({
          where: casWhere,
          data: { status: 'SUPERSEDED', leaseUntil: null, lastError: 'SUPERSEDED' },
        })
        continue
      }

      const customerName = [d.outbox.customer.firstName, d.outbox.customer.lastName].filter(Boolean).join(' ') || null
      const ok = await emailService.sendCustomerApprovalEmail(d.outbox.event as ApprovalOutboxEvent, d.recipient, {
        venueName: d.outbox.venue.name,
        customerName,
        bookingUrl: bookingUrlFor(d.outbox.venue.slug),
        dashboardUrl: dashboardInboxUrlFor(d.outbox.venue.slug),
        reason: d.reason ?? null,
        idempotencyKey: d.providerKey,
      })

      if (!ok) throw new Error('EMAIL_PROVIDER_REJECTED')

      sent += 1
      await prisma.customerApprovalDelivery.updateMany({
        where: casWhere,
        data: { status: 'SENT', sentAt: opts.now, leaseUntil: null, lastError: null },
      })
    } catch (error) {
      // Una entrega que truena NO puede detener al resto del lote: cada destinatario es
      // independiente, y ese es justamente el motivo de tener una fila por destinatario.
      failed += 1
      const outcome = resolveDeliveryOutcome({ attempts: d.attempts, now: opts.now, error: (error as Error).message })
      await prisma.customerApprovalDelivery.updateMany({
        where: casWhere,
        data: {
          status: outcome.status,
          lastError: outcome.lastError,
          leaseUntil: null,
          ...(outcome.nextAttemptAt ? { nextAttemptAt: outcome.nextAttemptAt } : {}),
        },
      })
    }
  }

  return { sent, failed, superseded }
}

/** Un tick completo: expandir lo nuevo, reclamar lo listo, entregarlo. */
export async function sweepOnce(input: { limit?: number; now?: Date } = {}): Promise<{
  expanded: number
  claimed: number
  sent: number
  failed: number
  superseded: number
}> {
  const now = input.now ?? new Date()
  const { expanded } = await expandPendingEvents({ limit: input.limit, now })

  const ids = await claimDeliveries({ limit: input.limit, now })
  if (ids.length === 0) return { expanded, claimed: 0, sent: 0, failed: 0, superseded: 0 }

  const rows = (await prisma.customerApprovalDelivery.findMany({
    where: { id: { in: ids } },
    include: {
      outbox: {
        select: {
          event: true,
          customerId: true,
          approvalVersion: true,
          venue: { select: { name: true, slug: true } },
          customer: { select: { firstName: true, lastName: true } },
        },
      },
    },
  })) as unknown as ClaimedDelivery[]

  const result = await deliverClaimed(rows, { now })
  return { expanded, claimed: rows.length, ...result }
}
