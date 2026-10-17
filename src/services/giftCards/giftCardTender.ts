// src/services/giftCards/giftCardTender.ts
/**
 * El tender de sistema «Tarjeta de regalo» (spec 2026-10-14 § 4.4, R4). Uno por negocio (`@@unique([venueId,
 * systemKind])`), oculto en el POS, que el negocio no edita ni apaga. Sólo lo usa el cobro con saldo
 * (`payGiftCardBalanceOnOrder`), que lo pasa YA RESUELTO al núcleo del pago: por eso `resolveTenderForCharge` puede
 * rechazarlo siempre (una app vieja que lo mande a mano recibe GIFT_CARD_TENDER_NOT_ALLOWED).
 */
import { PaymentFundsFlow, type Prisma, type PrismaClient } from '@prisma/client'
import { normalizeTenderName, type ResolvedTenderCharge } from '../dashboard/tenderType.dashboard.service'
import { GiftCardError } from './giftCardErrors'

export const NOMBRE_TENDER_DE_REGALO = 'Tarjeta de regalo'
export const NOMBRE_TENDER_DE_REGALO_ALTERNO = 'Tarjeta de regalo (Avoqado)'

// N1 (cierre): vive en un módulo sin Prisma (`giftCardPredicados`) para quien no puede cargar el cliente; aquí se re-exporta.
export { isGiftCardTenderKind } from './giftCardPredicados'

/** Llamar con el cliente GLOBAL, fuera de transacciones de dinero: el `create` puede chocar en una carrera (P2002). */
export async function ensureGiftCardTender(
  db: Prisma.TransactionClient | PrismaClient,
  venueId: string,
): Promise<{ id: string; revision: number }> {
  const existente = await db.venueTenderType.findFirst({
    where: { venueId, systemKind: 'GIFT_CARD' },
    select: { id: true, revision: true },
  })
  if (existente) return existente

  const nombreOcupado = await db.venueTenderType.findFirst({
    where: { venueId, normalizedName: normalizeTenderName(NOMBRE_TENDER_DE_REGALO) },
    select: { id: true },
  })
  const nombre = nombreOcupado ? NOMBRE_TENDER_DE_REGALO_ALTERNO : NOMBRE_TENDER_DE_REGALO

  try {
    return await db.venueTenderType.create({
      data: {
        venueId,
        name: nombre,
        normalizedName: normalizeTenderName(nombre),
        baseMethod: 'OTHER',
        isSystem: true,
        systemKind: 'GIFT_CARD',
        countsAsPhysicalCash: false,
        captureTip: true,
        showOnPos: false,
        posSection: 'MORE',
        displayOrder: 99,
        satFormaPago: '01',
        revision: 1,
        // La revisión 1 nace en la MISMA escritura (nested create): nunca un tender sin su copia congelada.
        revisions: {
          create: {
            revision: 1,
            name: nombre,
            countsAsPhysicalCash: false,
            captureTip: true,
            commissionPercent: null,
            satFormaPago: '01',
            createdBy: null,
          },
        },
      },
      select: { id: true, revision: true },
    })
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    const ganador = await db.venueTenderType.findFirst({
      where: { venueId, systemKind: 'GIFT_CARD' },
      select: { id: true, revision: true },
    })
    if (ganador) return ganador
    throw error
  }
}

/** El tender de regalo resuelto por el SERVIDOR con su revisión VIGENTE (el cobro con saldo nunca va sin red). */
export async function resolveGiftCardTenderForChargeInTx(tx: Prisma.TransactionClient, venueId: string): Promise<ResolvedTenderCharge> {
  const tender = await tx.venueTenderType.findFirst({
    where: { venueId, systemKind: 'GIFT_CARD' },
    select: { id: true, baseMethod: true, revision: true },
  })
  if (!tender) {
    throw new GiftCardError(
      'GIFT_CARDS_DISABLED',
      'Las tarjetas de regalo no están configuradas en este negocio. Actívalas en tu panel: Ajustes › Tarjetas de regalo.',
      409,
    )
  }
  const revision = await tx.venueTenderTypeRevision.findFirst({
    where: { tenderTypeId: tender.id, venueId, revision: tender.revision },
  })
  if (!revision) {
    throw new GiftCardError(
      'GIFT_CARDS_DISABLED',
      'El tipo de pago «Tarjeta de regalo» está incompleto. Avísale a soporte de Avoqado.',
      409,
    )
  }
  return {
    tenderTypeId: tender.id,
    tenderRevision: revision.revision,
    method: tender.baseMethod,
    tenderLabel: revision.name,
    tenderCountsAsCash: revision.countsAsPhysicalCash,
    tenderCaptureTip: revision.captureTip,
    tenderSatFormaPago: revision.satFormaPago,
    tenderCommissionPercent: revision.commissionPercent,
    fundsFlow: PaymentFundsFlow.EXTERNAL_RECORDED,
  }
}
