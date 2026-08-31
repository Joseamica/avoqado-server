/**
 * Fase 9 del kiosco — el aviso nocturno de renovación.
 *
 * De noche, cuando el negocio ya cerró, se revisa quién está por quedarse sin créditos o
 * con el paquete a punto de vencer, y se le manda un recordatorio con el enlace para
 * renovar.
 *
 * 🔴 Tres candados en AND, y ninguno sobra:
 *
 *   1. El NEGOCIO lo prendió (`ReservationSettings.nightlyOutreachEnabled`, apagado por
 *      defecto). El mensaje sale con su nombre; la decisión es suya.
 *   2. La PERSONA aceptó marketing (`Customer.marketingConsent`). Sin eso no sale, aunque
 *      el negocio quiera — y aunque sea un cliente que compra cada semana.
 *   3. El enlace de renovación EXISTE. Mandar "ya casi se te acaban" sin decir dónde
 *      renovar es peor que no mandar nada.
 *
 * La entrega va por outbox durable, igual que los avisos de aprobación (Fase 1): la
 * intención se graba en la base y el envío ocurre después. Si el proceso muere a media
 * noche el aviso sigue en la fila, y `dedupeKey` impide que a alguien le llegue dos veces.
 */

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import emailService from '@/services/email.service'

/** Con dos créditos o menos se avisa: da tiempo a renovar sin quedarse a medias. */
export const LOW_CREDITS_THRESHOLD = 2
/** Y una semana antes de que venza el paquete. */
export const EXPIRING_WITHIN_DAYS = 7
/** Después de seis fallos queda FAILED para revisión manual, sin un loop infinito. */
export const MAX_OUTREACH_ATTEMPTS = 6

/** `evento:cliente:fecha` — el barrido de la misma noche no vuelve a encolar. */
function dedupeKey(event: string, customerId: string, now: Date): string {
  return `${event}:${customerId}:${now.toISOString().slice(0, 10)}`
}

/**
 * El enlace apunta a la lista de paquetes del negocio, no a una sesión de pago ya creada.
 * Es deliberado: el aviso sale de noche y una sesión de Stripe caduca en ~24 h — el enlace
 * tiene que seguir sirviendo el martes, no sólo la mañana siguiente.
 */
function renewalUrl(slug: string): string {
  const base = process.env.BOOKING_SITE_URL ?? 'https://book.avoqado.io'
  return `${base}/${encodeURIComponent(slug)}?packs=1`
}

export async function enqueueNightlyOutreach(args: { now: Date; venueId?: string }): Promise<{ enqueued: number; skipped: number }> {
  const venues = await prisma.venue.findMany({
    where: {
      ...(args.venueId ? { id: args.venueId } : {}),
      // Candado 1: lo prendió el negocio.
      reservationSettings: { nightlyOutreachEnabled: true },
    },
    select: { id: true, slug: true },
  })

  let enqueued = 0
  let skipped = 0

  const expiringBefore = new Date(args.now.getTime() + EXPIRING_WITHIN_DAYS * 24 * 60 * 60 * 1000)

  for (const venue of venues) {
    const purchases = await prisma.creditPackPurchase.findMany({
      where: {
        venueId: venue.id,
        status: 'ACTIVE',
        // Candado 2: la persona aceptó. Va en el WHERE, no en un `if` más abajo —
        // así no hay camino en el código que se lo salte por descuido.
        customer: { marketingConsent: true },
        OR: [{ expiresAt: { not: null, lte: expiringBefore, gt: args.now } }, {}],
      },
      select: {
        id: true,
        customerId: true,
        expiresAt: true,
        creditPack: { select: { name: true } },
        itemBalances: { select: { remainingQuantity: true } },
      },
    })

    for (const p of purchases) {
      const remaining = p.itemBalances.reduce((sum, b) => sum + b.remainingQuantity, 0)
      const lowCredits = remaining > 0 && remaining <= LOW_CREDITS_THRESHOLD
      const expiringSoon = p.expiresAt != null && p.expiresAt > args.now && p.expiresAt <= expiringBefore

      if (!lowCredits && !expiringSoon) {
        skipped++
        continue
      }

      const event = lowCredits ? 'CREDITS_RUNNING_OUT' : 'PACK_EXPIRING'
      const key = dedupeKey(event, p.customerId, args.now)

      // Candado 3: sin enlace no se encola.
      const url = renewalUrl(venue.slug)
      if (!url) {
        skipped++
        continue
      }

      try {
        await prisma.kioskOutreachOutbox.create({
          data: {
            venueId: venue.id,
            customerId: p.customerId,
            event: event as never,
            dedupeKey: key,
            paymentLinkUrl: url,
            payload: { packName: p.creditPack?.name ?? null, remaining, expiresAt: p.expiresAt },
          },
        })
        enqueued++
      } catch {
        // Choque contra `dedupeKey`: ya se encoló esta noche. Es el caso normal de un
        // segundo barrido, no un error.
        skipped++
      }
    }
  }

  logger.info('🌙 [KIOSK OUTREACH] Barrido nocturno', { enqueued, skipped, venues: venues.length })
  return { enqueued, skipped }
}

/** Reclama y entrega lo pendiente. Lease para que dos procesos no manden lo mismo. */
export async function sweepOnce(args: { now: Date; batchSize?: number }): Promise<{ sent: number; failed: number }> {
  const batchSize = Math.max(1, Math.min(args.batchSize ?? 50, 100))
  const leaseUntil = new Date(args.now.getTime() + 5 * 60_000)
  const nowSql = Prisma.sql`${args.now.toISOString()}::timestamp`
  const leaseSql = Prisma.sql`${leaseUntil.toISOString()}::timestamp`

  // Selección + claim forman UNA sentencia. El findMany seguido de updateMany anterior
  // permitía que dos procesos vieran el mismo PENDING antes de que cualquiera pusiera el
  // lease. FAILED también vuelve a entrar mientras conserve intentos disponibles.
  const candidates = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH candidates AS (
      SELECT o.id
      FROM "KioskOutreachOutbox" AS o
      WHERE o.status IN ('PENDING', 'FAILED')
        AND o.attempts < ${MAX_OUTREACH_ATTEMPTS}
        AND (o."leasedUntil" IS NULL OR o."leasedUntil" <= ${nowSql})
      ORDER BY o."createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "KioskOutreachOutbox" AS o
    SET "leasedUntil" = ${leaseSql}, attempts = o.attempts + 1, "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE o.id = candidates.id
    RETURNING o.id
  `)
  if (candidates.length === 0) return { sent: 0, failed: 0 }

  const rows = await prisma.kioskOutreachOutbox.findMany({
    where: { id: { in: candidates.map(c => c.id) }, leasedUntil: leaseUntil },
    select: {
      id: true,
      dedupeKey: true,
      attempts: true,
      event: true,
      paymentLinkUrl: true,
      payload: true,
      venue: { select: { name: true } },
      customer: { select: { email: true, firstName: true, marketingConsent: true } },
    },
  })

  let sent = 0
  let failed = 0

  for (const row of rows) {
    const casWhere = { id: row.id, attempts: row.attempts, leasedUntil: leaseUntil }
    // Se revisa OTRA VEZ al entregar: entre el barrido y el envío pudo darse de baja,
    // y la baja tiene que ganar siempre.
    if (!row.customer?.marketingConsent) {
      await prisma.kioskOutreachOutbox.updateMany({
        where: casWhere,
        data: { status: 'SKIPPED', leasedUntil: null, lastError: 'MARKETING_CONSENT_REVOKED' },
      })
      continue
    }
    if (!row.customer.email) {
      await prisma.kioskOutreachOutbox.updateMany({
        where: casWhere,
        data: { status: 'SKIPPED', leasedUntil: null, lastError: 'NO_CHANNEL' },
      })
      continue
    }

    const packName = (row.payload as { packName?: string } | null)?.packName ?? 'tu paquete'
    const isExpiring = row.event === 'PACK_EXPIRING'
    const subject = isExpiring ? `${packName} está por vencer` : `Te quedan pocas clases de ${packName}`

    let ok = false
    let lastError = 'SEND_FAILED'
    try {
      ok = await emailService.sendEmail({
        to: row.customer.email,
        subject,
        html:
          `<p>Hola ${row.customer.firstName ?? ''},</p>` +
          `<p>${isExpiring ? `${packName} vence pronto.` : `Ya casi terminas ${packName}.`} ` +
          `Puedes renovarlo cuando quieras:</p>` +
          `<p><a href="${row.paymentLinkUrl}">Renovar en ${row.venue?.name ?? 'el estudio'}</a></p>`,
        // Resend deduplica esta llave incluso si el proceso muere después de que el
        // proveedor aceptó el correo pero antes de persistir SENT.
        idempotencyKey: row.dedupeKey,
      })
    } catch (error) {
      lastError = (error as Error).message.slice(0, 1_000) || 'SEND_FAILED'
    }

    await prisma.kioskOutreachOutbox.updateMany({
      where: casWhere,
      data: ok
        ? { status: 'SENT', sentAt: args.now, leasedUntil: null, lastError: null }
        : { status: 'FAILED', leasedUntil: null, lastError },
    })
    if (ok) sent++
    else failed++
  }

  return { sent, failed }
}
