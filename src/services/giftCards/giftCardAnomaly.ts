// src/services/giftCards/giftCardAnomaly.ts
/**
 * Anomalías de dinero de tarjetas de regalo (R6). `MoneyAnomaly` no tiene `venueId`: la llave determinista va en
 * `stripeEventId = 'giftcard:<check>:<id>'`, que con `category` deduplica (`@@unique([stripeEventId, category])`).
 * Se escribe con `createMany({ skipDuplicates })` (INSERT … ON CONFLICT DO NOTHING) porque corre DENTRO de
 * transacciones de dinero: un P2002 abortaría la transacción entera y se llevaría el cobro.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import logger from '@/config/logger'

export type GiftCardAnomalyCheck =
  | 'BALANCE_MISMATCH'
  | 'PAID_WITH_PENDING'
  | 'TENDER_WITHOUT_REDEEM'
  | 'ACTIVATION_AMOUNT_MISMATCH'
  // Conciliación 14-oct: B1 (la terminal ya devolvió una venta sin cancelación, enmienda E1) y B7 (revisión nocturna).
  | 'REFUND_WITHOUT_CANCEL'
  | 'REFUND_WITHOUT_REVERSAL'
  | 'CANCEL_STUCK'
  // Ruling A6: una cuenta de tarjetas cancelada (sobres DEACTIVATED) recibió dinero y quedó PAGADA; los sobres no se reviven.
  | 'PAID_WITH_DEACTIVATED'

export async function recordGiftCardAnomaly(
  db: Prisma.TransactionClient | PrismaClient,
  a: { check: GiftCardAnomalyCheck; id: string; venueId: string; detail: Record<string, unknown> },
): Promise<void> {
  const venue = await db.venue.findUnique({ where: { id: a.venueId }, select: { name: true } })
  await db.moneyAnomaly.createMany({
    data: [
      {
        category: `GIFT_CARD_${a.check}`,
        stripeEventId: `giftcard:${a.check}:${a.id}`,
        expectedState: { venueId: a.venueId, id: a.id, check: a.check },
        observedState: a.detail as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  })
  logger.error('🚨 [TARJETAS DE REGALO] Anomalía de dinero', {
    check: a.check,
    id: a.id,
    venueId: a.venueId,
    venueName: venue?.name ?? null,
    detail: a.detail,
  })
}
