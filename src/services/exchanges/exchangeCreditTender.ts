// src/services/exchanges/exchangeCreditTender.ts
/**
 * El tender de sistema «Crédito de cambio» (spec 2026-10-20 §6.2). Uno por negocio (`@@unique([venueId, systemKind])`), oculto
 * en el POS, que el negocio no edita ni apaga. Es la parte de un cambio que se aplica a la prenda nueva: forma SAT 17
 * (Compensación), fuera del cajón y del banco (`EXTERNAL_RECORDED`). Sólo lo escribe la operación de Cambio, que lo pasa YA
 * RESUELTO al núcleo del cobro; por eso `resolveTenderForCharge` lo rechaza siempre (EXCHANGE_CREDIT_TENDER_NOT_ALLOWED).
 *
 * Gemelo de `ensureGiftCardTender` (`giftCards/giftCardTender.ts`), con el kind, los nombres y la semántica de dinero del crédito.
 */
import { PaymentFundsFlow, type Prisma, type PrismaClient } from '@prisma/client'
import AppError from '@/errors/AppError'
import { normalizeTenderName, type ResolvedTenderCharge } from '../dashboard/tenderType.dashboard.service'

export const EXCHANGE_CREDIT_TENDER_NAME = 'Crédito de cambio'
const EXCHANGE_CREDIT_TENDER_ALTERNATE_NAME = 'Crédito de cambio (Avoqado)'

/** Llamar con el cliente GLOBAL, fuera de transacciones de dinero: el `create` puede chocar en una carrera (P2002). */
export async function ensureExchangeCreditTender(
  db: Prisma.TransactionClient | PrismaClient,
  venueId: string,
): Promise<{ id: string; revision: number }> {
  const existente = await db.venueTenderType.findFirst({
    where: { venueId, systemKind: 'EXCHANGE_CREDIT' },
    select: { id: true, revision: true },
  })
  if (existente) return existente

  const nombreOcupado = await db.venueTenderType.findFirst({
    where: { venueId, normalizedName: normalizeTenderName(EXCHANGE_CREDIT_TENDER_NAME) },
    select: { id: true },
  })
  const nombre = nombreOcupado ? EXCHANGE_CREDIT_TENDER_ALTERNATE_NAME : EXCHANGE_CREDIT_TENDER_NAME

  try {
    return await db.venueTenderType.create({
      data: {
        venueId,
        name: nombre,
        normalizedName: normalizeTenderName(nombre),
        baseMethod: 'OTHER',
        isSystem: true,
        systemKind: 'EXCHANGE_CREDIT',
        countsAsPhysicalCash: false,
        captureTip: false,
        showOnPos: false,
        posSection: 'MORE',
        displayOrder: 99,
        satFormaPago: '17',
        commissionPercent: null,
        revision: 1,
        // La revisión 1 nace en la MISMA escritura (nested create): nunca un tender sin su copia congelada.
        revisions: {
          create: {
            revision: 1,
            name: nombre,
            countsAsPhysicalCash: false,
            captureTip: false,
            commissionPercent: null,
            satFormaPago: '17',
            createdBy: null,
          },
        },
      },
      select: { id: true, revision: true },
    })
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    const ganador = await db.venueTenderType.findFirst({
      where: { venueId, systemKind: 'EXCHANGE_CREDIT' },
      select: { id: true, revision: true },
    })
    if (ganador) return ganador
    throw error
  }
}

/** El tender del crédito resuelto por el SERVIDOR con su revisión VIGENTE, dentro de la transacción del cambio. */
export async function resolveExchangeCreditTenderInTx(tx: Prisma.TransactionClient, venueId: string): Promise<ResolvedTenderCharge> {
  const tender = await tx.venueTenderType.findFirst({
    where: { venueId, systemKind: 'EXCHANGE_CREDIT' },
    select: { id: true, baseMethod: true, revision: true },
  })
  const revision = tender
    ? await tx.venueTenderTypeRevision.findFirst({ where: { tenderTypeId: tender.id, venueId, revision: tender.revision } })
    : null
  if (!tender || !revision) {
    throw new AppError(
      'El tipo de pago «Crédito de cambio» no está listo en este negocio. Intenta de nuevo y, si sigue, avísale a soporte de Avoqado.',
      422,
      true,
      'EXCHANGE_SETTLEMENT_UNAVAILABLE',
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
    // Nunca del cajón ni del banco: el crédito no mueve dinero, sólo aplica a la venta nueva lo que regresó (spec §6.1).
    fundsFlow: PaymentFundsFlow.EXTERNAL_RECORDED,
  }
}
