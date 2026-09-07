/**
 * Live Demo Cleanup Service
 *
 * Automatically cleans up expired live demo sessions.
 * Deletes venues, staff, and all associated data for sessions that have:
 * 1. Expired (expiresAt < now)
 * 2. Been inactive for > 5 hours (lastActivityAt + 5 hours < now)
 */

import prisma from '@/utils/prismaClient'
import { addHours } from 'date-fns'
import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { deleteOrRetainStaffWithH1ProvenanceTx, isH1ProvenanceConstraint } from '@/services/superadmin/staffDeletion.service'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'

const INACTIVITY_THRESHOLD_HOURS = 5

/**
 * 🔴 Presupuesto de la transacción que borra un demo entero.
 *
 * Prisma le da 5 s a una transacción interactiva. No alcanzan: el borrado final del venue arrastra
 * en cascada ~193 modelos, varios sobre tablas de decenas de miles de filas y algunos con la
 * columna `venueId` SIN índice en producción, así que Postgres las recorre en secuencial. Agotado
 * el reloj, Prisma tumba la transacción con P2028 y el modelo que aparece en el error es
 * simplemente el enunciado que tocaba en ese instante — por eso en producción cambiaba en cada
 * pasada (`order`, `menu`, `webhookEvent`, `venueFeature`, `venue.delete`) y parecía cinco fallos
 * distintos en vez de uno.
 *
 * NO se parte en varias transacciones: el `FOR UPDATE` sobre el venue es lo único que impide que
 * una transición LIVE_DEMO → negocio real ocurra a media limpieza (hay prueba de integración de
 * esa carrera). Se sube el presupuesto y se deja acotado, para que un cuelgue siga fallando fuerte
 * en vez de retener el lock para siempre.
 */
const DELETION_TIMEOUT_MS = 60_000

/** Espera por un lugar en el pool: en el minuto :00 este job compite con ~40 crones. */
const DELETION_MAX_WAIT_MS = 10_000

type DbClient = Prisma.TransactionClient

interface DisposableDemoSession {
  id: string
  venueId: string
  staffId: string
}

export function createDisposableDemoSessionDeletion(
  overrides: { prisma?: typeof prisma; afterVenueLock?: (venueId: string) => Promise<void> } = {},
) {
  const db = overrides.prisma ?? prisma
  return async (session: DisposableDemoSession): Promise<number> => {
    try {
      return await db.$transaction(
        async tx => {
          // WHY: Venue disposition, Staff provenance classification, and every
          // destructive write share one transaction. The row lock makes a
          // concurrent LIVE_DEMO -> real venue transition wait until cleanup has
          // atomically committed or rolled back.
          const venues = await tx.$queryRaw<Array<{ id: string; name: string; status: string }>>(Prisma.sql`
        SELECT id, name, status FROM "Venue" WHERE id = ${session.venueId} FOR UPDATE
      `)
          const venue = venues[0]
          if (!venue || venue.status !== 'LIVE_DEMO') {
            throw new ConflictError('La sucursal ya no es un demo desechable', 'LIVE_DEMO_VENUE_NOT_DISPOSABLE')
          }
          await overrides.afterVenueLock?.(session.venueId)
          const result = await deleteOrRetainStaffWithH1ProvenanceTx(tx, session.staffId)
          if (result.retainedForAudit) {
            throw new ConflictError(
              'El Staff del demo conserva provenance H1 y requiere revisión manual',
              'LIVE_DEMO_STAFF_HAS_H1_PROVENANCE',
            )
          }
          const filasBorradas = await deleteVenueDataTx(tx, session.venueId)
          // Venue deletion cascades the session, so this remains idempotent.
          const sesion = await tx.liveDemoSession.deleteMany({ where: { id: session.id } })
          return filasBorradas + sesion.count
        },
        { timeout: DELETION_TIMEOUT_MS, maxWait: DELETION_MAX_WAIT_MS },
      )
    } catch (error) {
      if (isH1ProvenanceConstraint(error) || (error as { code?: string }).code === 'STAFF_HAS_H1_PROVENANCE') {
        throw new ConflictError('El Staff del demo conserva provenance H1 y requiere revisión manual', 'LIVE_DEMO_STAFF_HAS_H1_PROVENANCE')
      }
      throw error
    }
  }
}

export const deleteDisposableDemoSession = createDisposableDemoSessionDeletion()

/**
 * Cleans up expired and inactive live demo sessions
 * Should be run periodically (e.g., every hour via cron)
 *
 * @returns Number of sessions cleaned up
 */
export async function cleanupExpiredLiveDemos(): Promise<number> {
  try {
    logger.info('🧹 Starting live demo cleanup...')

    const now = new Date()
    const inactivityThreshold = addHours(now, -INACTIVITY_THRESHOLD_HOURS)

    // Find expired or inactive sessions.
    // La lectura de entrada va con `retry`: en el minuto :00 se alinean ~40 crones y la ráfaga de
    // conexiones nuevas agota el `connect_timeout` de Prisma (P1001). Es una lectura pura, así que
    // repetirla no tiene efectos — regla `.claude/rules/cron-jobs.md`.
    const expiredSessions = await retry(
      () =>
        prisma.liveDemoSession.findMany({
          where: {
            OR: [
              {
                // Session has expired
                expiresAt: {
                  lt: now,
                },
              },
              {
                // Session has been inactive for too long
                lastActivityAt: {
                  lt: inactivityThreshold,
                },
              },
            ],
          },
          include: {
            venue: true,
            staff: true,
          },
        }),
      { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'live-demo-cleanup.findExpiredSessions' },
    )

    if (expiredSessions.length === 0) {
      logger.info('✅ No expired live demo sessions found')
      return 0
    }

    logger.info(`🗑️ Found ${expiredSessions.length} expired live demo sessions to clean up`)

    let cleanedCount = 0
    let filasBorradas = 0

    for (const session of expiredSessions) {
      try {
        // Delete venue and staff data manually to avoid foreign key constraint errors
        logger.info(`🗑️ Cleaning up venue: ${session.venue.name} (${session.venue.id})`)

        // Staff deletion performs the row-lock + provenance decision before
        // any venue data is removed, so cleanup fails closed without partial loss.
        filasBorradas += await deleteDisposableDemoSession(session)

        logger.info(`✅ Cleaned up live demo session ${session.sessionId} (venue: ${session.venue.name}, staff: ${session.staff.email})`)

        cleanedCount++
      } catch (error) {
        logger.error(`❌ Error cleaning up session ${session.sessionId}:`, error)
        // Continue with other sessions even if one fails
      }
    }

    logger.info(`✅ Live demo cleanup complete. Cleaned ${cleanedCount} sessions, ${filasBorradas} filas borradas.`)

    return cleanedCount
  } catch (error) {
    logger.error('❌ Error in cleanupExpiredLiveDemos:', error)
    throw error
  }
}

/**
 * Cleans up ALL live demo sessions (for testing/development)
 * WARNING: This will delete all live demo venues and sessions
 *
 * @returns Number of sessions cleaned up
 */
export async function cleanupAllLiveDemos(): Promise<number> {
  try {
    logger.warn('⚠️ Cleaning up ALL live demo sessions (including active ones)...')

    const allSessions = await prisma.liveDemoSession.findMany({
      include: {
        venue: true,
        staff: true,
      },
    })

    if (allSessions.length === 0) {
      logger.info('✅ No live demo sessions found')
      return 0
    }

    logger.info(`🗑️ Found ${allSessions.length} live demo sessions to clean up`)

    let cleanedCount = 0
    let filasBorradas = 0

    for (const session of allSessions) {
      try {
        // Delete venue and staff data manually to avoid foreign key constraint errors
        logger.info(`🗑️ Cleaning up venue: ${session.venue.name} (${session.venue.id})`)

        filasBorradas += await deleteDisposableDemoSession(session)

        logger.info(`✅ Cleaned up session ${session.sessionId}`)
        cleanedCount++
      } catch (error) {
        logger.error(`❌ Error cleaning up session ${session.sessionId}:`, error)
      }
    }

    logger.info(`✅ Cleanup complete. Cleaned ${cleanedCount} sessions, ${filasBorradas} filas borradas.`)

    return cleanedCount
  } catch (error) {
    logger.error('❌ Error in cleanupAllLiveDemos:', error)
    throw error
  }
}

/**
 * Get statistics about live demo sessions
 *
 * @returns Live demo statistics
 */
export async function getLiveDemoStats(): Promise<{
  total: number
  active: number
  expired: number
  inactive: number
}> {
  const now = new Date()
  const inactivityThreshold = addHours(now, -INACTIVITY_THRESHOLD_HOURS)

  const total = await prisma.liveDemoSession.count()

  const active = await prisma.liveDemoSession.count({
    where: {
      expiresAt: { gte: now },
      lastActivityAt: { gte: inactivityThreshold },
    },
  })

  const expired = await prisma.liveDemoSession.count({
    where: {
      expiresAt: { lt: now },
    },
  })

  const inactive = await prisma.liveDemoSession.count({
    where: {
      lastActivityAt: { lt: inactivityThreshold },
      expiresAt: { gte: now }, // Not yet expired, just inactive
    },
  })

  return {
    total,
    active,
    expired,
    inactive,
  }
}

/**
 * Deletes all venue-related data in the correct order to avoid foreign key constraints
 *
 * @param venueId - Venue ID to delete data for
 */
async function deleteVenueDataTx(tx: DbClient, venueId: string): Promise<number> {
  // 🔒 HARD GUARD — this function ERASES a venue and everything in it.
  // It must be physically impossible to point it at a real business: if a
  // LiveDemoSession row ever references a non-LIVE_DEMO venue (bug, manual
  // data edit, tampering), we refuse loudly instead of destroying it.
  const venue = await tx.venue.findUnique({
    where: { id: venueId },
    select: { status: true, name: true },
  })
  if (!venue) {
    logger.warn(`🗑️ deleteVenueData: venue ${venueId} no longer exists — nothing to delete`)
    return 0
  }
  if (venue.status !== 'LIVE_DEMO') {
    logger.error(
      `🚨 deleteVenueData REFUSED: venue ${venueId} ("${venue.name}") has status ${venue.status}, not LIVE_DEMO. ` +
        `A live-demo session is pointing at a REAL venue — investigate immediately.`,
    )
    throw new Error(`Refusing to delete non-LIVE_DEMO venue ${venueId} (status: ${venue.status})`)
  }

  logger.info(`🗑️ Deleting all data for venue ${venueId}...`)

  // Cuántas filas se llevó la limpieza. Un «Cleaned 1 sessions» no dice si borró 3 filas o 3 000,
  // y esa cifra es justo la que faltaba al investigar por qué la transacción agotaba su reloj.
  let filasBorradas = 0
  const borrar = async (borrado: Promise<{ count: number }>): Promise<void> => {
    filasBorradas += (await borrado).count
  }

  // Delete in correct order (most dependent first)
  // 1. Order items and payments
  await borrar(tx.orderItem.deleteMany({ where: { order: { venueId } } }))
  await borrar(tx.payment.deleteMany({ where: { order: { venueId } } }))
  await borrar(tx.order.deleteMany({ where: { venueId } }))

  // 2. Reviews
  await borrar(tx.review.deleteMany({ where: { venueId } }))

  // 3. Products and modifiers
  await borrar(tx.productModifierGroup.deleteMany({ where: { product: { venueId } } }))
  await borrar(tx.modifier.deleteMany({ where: { group: { venueId } } }))
  await borrar(tx.modifierGroup.deleteMany({ where: { venueId } }))

  // 4. Recipes and inventory
  await borrar(tx.recipe.deleteMany({ where: { product: { venueId } } }))
  await borrar(tx.rawMaterialMovement.deleteMany({ where: { rawMaterial: { venueId } } }))
  await borrar(tx.rawMaterial.deleteMany({ where: { venueId } }))
  await borrar(tx.inventory.deleteMany({ where: { venueId } }))

  // 4.5 TODO lo que apunta a un producto y BLOQUEA su borrado.
  //
  // 🔴 Siete claves foráneas con RESTRICT / NO ACTION cuelgan de `Product`, y basta UNA para
  // tumbar la transacción entera — con ella, la limpieza de demos no borraba NADA. El job
  // llevaba días fallando cada hora con `CreditPackItem_productId_fkey` y las sesiones
  // caducadas se acumulaban en silencio («Cleaned 0 sessions» en cada pasada).
  //
  // 🔑 Se enumeraron las SIETE contra la base antes de tocar nada. Arreglar sólo la que salía
  // en el error habría movido el fallo a la siguiente, y el job habría seguido sin limpiar.
  // Donde el schema ya CASCADEA (CreditPack→Item, Promotion→Grupo→Opción, PurchaseOrder→Item)
  // se borra sólo el padre; lo demás va explícito, de la hoja a la raíz.

  // Créditos. `CreditTransaction` referencia el saldo y la compra, así que abre la fila.
  await borrar(tx.creditTransaction.deleteMany({ where: { venueId } }))
  await borrar(
    tx.creditItemBalance.deleteMany({
      // Por las DOS vías: el saldo puede alcanzarse por su producto o por su paquete, y usar
      // una sola dejaría filas que vuelven a bloquear.
      where: { OR: [{ product: { venueId } }, { creditPackItem: { creditPack: { venueId } } }] },
    }),
  )
  await borrar(tx.creditPackPurchase.deleteMany({ where: { venueId } }))
  await borrar(tx.creditPack.deleteMany({ where: { venueId } })) // cascada → CreditPackItem

  // Promociones. Borrar la promoción arrastra sus grupos y opciones por cascada; lo que la
  // bloquea a ella es `OrderPromotion`, que ya cayó con las órdenes del paso 1.
  await borrar(tx.orderPromotion.deleteMany({ where: { promotion: { venueId } } }))
  await borrar(tx.promotion.deleteMany({ where: { venueId } }))

  // Órdenes de compra (cascada → PurchaseOrderItem).
  await borrar(tx.purchaseOrder.deleteMany({ where: { venueId } }))

  // Upsell: la REGLA cascadea desde su producto sugerido, así que muere en el paso 5 — pero la
  // aceptación la referencia con RESTRICT y no cuelga del producto. Va antes que los productos.
  await borrar(tx.upsellAcceptance.deleteMany({ where: { rule: { venueId } } }))

  // Catálogo central: de la hoja a la raíz, porque las líneas apuntan al binding.
  await borrar(tx.catalogPublicationFieldDecision.deleteMany({ where: { line: { venueId } } }))
  await borrar(tx.catalogPublicationLine.deleteMany({ where: { venueId } }))
  await borrar(tx.catalogVenueOverride.deleteMany({ where: { venueId } }))
  await borrar(tx.catalogVenueBinding.deleteMany({ where: { venueId } }))
  await borrar(tx.catalogBindingLine.deleteMany({ where: { venueId } }))

  // 5. Products
  await borrar(tx.product.deleteMany({ where: { venueId } }))

  // 6. Menu categories and menus
  await borrar(tx.menuCategoryAssignment.deleteMany({ where: { menu: { venueId } } }))
  await borrar(tx.menuCategory.deleteMany({ where: { venueId } }))
  await borrar(tx.menu.deleteMany({ where: { venueId } }))

  // 7. Tables and areas
  await borrar(tx.table.deleteMany({ where: { venueId } }))
  await borrar(tx.area.deleteMany({ where: { venueId } }))

  // 8. Shifts and staff assignments
  await borrar(tx.shift.deleteMany({ where: { venueId } }))
  await borrar(tx.staffVenue.deleteMany({ where: { venueId } }))

  // 9. Payment config + the merchant accounts it points to.
  // MerchantAccount has NO venueId and its FK from VenuePaymentConfig is
  // onDelete: Restrict (schema.prisma) — it does NOT cascade. The Stripe/Blumon
  // demo accounts seedDemoVenue created just for this venue would otherwise
  // orphan forever in the global MerchantAccount table (found accumulating in
  // prod's superadmin "Cuentas de Comercio" screen, 2026-07-06).
  const paymentConfig = await tx.venuePaymentConfig.findUnique({ where: { venueId } })
  await borrar(tx.venuePaymentConfig.deleteMany({ where: { venueId } }))
  if (paymentConfig) {
    const merchantAccountIds = [paymentConfig.primaryAccountId, paymentConfig.secondaryAccountId, paymentConfig.tertiaryAccountId].filter(
      (id): id is string => Boolean(id),
    )
    if (merchantAccountIds.length > 0) {
      await borrar(tx.merchantAccount.deleteMany({ where: { id: { in: merchantAccountIds } } }))
    }
  }

  // 10. Features and settings
  await borrar(tx.venueFeature.deleteMany({ where: { venueId } }))
  await borrar(tx.venueSettings.deleteMany({ where: { venueId } }))

  // 11. Webhook events
  await borrar(tx.webhookEvent.deleteMany({ where: { venueId } }))

  // 11.5 🔴 Lo que BLOQUEA el borrado del VENUE — la MISMA familia que el paso 4.5, un nivel
  // más arriba, y lo que tumbó la limpieza en producción el 2026-09-05 con
  // `ConsentEvent_noticeVersionId_fkey`.
  //
  // Que el schema CASCADEE una tabla desde `Venue` no basta: si un hijo RESTRICT apunta a otra
  // tabla que TAMBIÉN muere en ese cascade, Postgres no garantiza en qué orden recorre las dos
  // ramas hermanas, así que puede intentar quitar el padre primero y reventar la transacción
  // entera. Aquí se cortan esas parejas antes de llegar al `venue.delete`.
  //
  // 🔑 Están enumeradas contra el DMMF, no adivinadas: hay una prueba
  // (`liveDemoCleanup.service.test.ts`) que recorre el grafo de Prisma y falla si alguien agrega
  // una relación así — es el tercer defecto idéntico en tres meses, y siempre se descubrió por el
  // cron fallando cada hora en producción.
  await borrar(tx.consentEvent.deleteMany({ where: { venueId } })) // → PrivacyNoticeVersion
  await borrar(tx.paymentLink.deleteMany({ where: { venueId } })) // → EcommerceMerchant
  await borrar(tx.serializedItem.deleteMany({ where: { venueId } })) // → ItemCategory
  await borrar(tx.referralRewardGrant.deleteMany({ where: { venueId } })) // → ReferralTierReward
  // Comisiones, de la hoja a la raíz: el ajuste referencia el cálculo y el resumen; el cálculo
  // referencia su configuración y el pago su resumen.
  await borrar(tx.commissionClawback.deleteMany({ where: { OR: [{ calculation: { venueId } }, { summary: { venueId } }] } }))
  await borrar(tx.commissionPayout.deleteMany({ where: { venueId } })) // → CommissionSummary
  await borrar(tx.commissionCalculation.deleteMany({ where: { venueId } })) // → CommissionConfig

  // 12. Finally, delete the venue
  await tx.venue.delete({ where: { id: venueId } })
  filasBorradas += 1

  logger.info(`✅ Successfully deleted all data for venue ${venueId} — ${filasBorradas} filas`)
  return filasBorradas
}
