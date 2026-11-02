// src/services/storeCredit/storeCreditTender.ts
/**
 * El tender de sistema «Saldo a favor» (spec 2026-10-30-saldo-a-favor §5.1 y §5.3). Uno por sucursal (`@@unique([venueId,
 * systemKind])`), oculto en el POS, que el negocio no edita ni apaga y que una app no puede mandar a mano (`resolveTenderForCharge`
 * rechaza todo `systemKind` de sistema). Es el DESTINO de una devolución cuyo importe se abona al sobre del cliente: forma SAT 17
 * (Compensación), fuera del cajón y del banco (`EXTERNAL_RECORDED`). Va aparte de `GIFT_CARD` a propósito: con `GIFT_CARD` esa
 * devolución pasaría por «cobro con saldo de regalo» en los lectores de tarjetas (ISR, factura, resumen de ventas).
 *
 * Gemelo de `ensureGiftCardTender` y `ensureExchangeCreditTender`. 🔴 Se llama con el cliente GLOBAL y ANTES de abrir la transacción
 * de dinero: el medio nace con su revisión anidada (SELECT + INSERT) y un P2002 dentro de la transacción la abortaría entera.
 */
import { PaymentFundsFlow, type Prisma } from '@prisma/client'
import AppError from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { normalizeTenderName, type ResolvedTenderCharge } from '../dashboard/tenderType.dashboard.service'
import { giftCardKeysPresent } from '../giftCards/giftCardCode'
import { ensureGiftCardTender } from '../giftCards/giftCardTender'

export const NOMBRE_TENDER_SALDO_A_FAVOR = 'Saldo a favor'
export const NOMBRE_TENDER_SALDO_A_FAVOR_ALTERNO = 'Saldo a favor (Avoqado)'

/** ¿El SERVIDOR sabe dar saldo a favor? Las mismas dos llaves de las tarjetas de regalo (sin ellas no se puede crear ningún sobre). */
export function storeCreditAvailable(): boolean {
  return giftCardKeysPresent()
}

/** Idempotente. Cliente global, fuera de transacciones de dinero: una carrera (P2002) la gana quien escribió primero. */
export async function ensureStoreCreditTender(venueId: string): Promise<{ id: string; revision: number }> {
  const existente = await prisma.venueTenderType.findFirst({
    where: { venueId, systemKind: 'STORE_CREDIT' },
    select: { id: true, revision: true },
  })
  if (existente) return existente

  const nombreOcupado = await prisma.venueTenderType.findFirst({
    where: { venueId, normalizedName: normalizeTenderName(NOMBRE_TENDER_SALDO_A_FAVOR) },
    select: { id: true },
  })
  const nombre = nombreOcupado ? NOMBRE_TENDER_SALDO_A_FAVOR_ALTERNO : NOMBRE_TENDER_SALDO_A_FAVOR

  try {
    return await prisma.venueTenderType.create({
      data: {
        venueId,
        name: nombre,
        normalizedName: normalizeTenderName(nombre),
        baseMethod: 'OTHER',
        isSystem: true,
        systemKind: 'STORE_CREDIT',
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
    const ganador = await prisma.venueTenderType.findFirst({
      where: { venueId, systemKind: 'STORE_CREDIT' },
      select: { id: true, revision: true },
    })
    if (ganador) return ganador
    throw error
  }
}

/** Los dos medios que hacen falta para dar y gastar saldo a favor: `STORE_CREDIT` (la devolución) y `GIFT_CARD` (gastarlo). */
export async function prepararMediosDeSaldoAFavor(venueId: string): Promise<void> {
  await ensureGiftCardTender(prisma, venueId)
  await ensureStoreCreditTender(venueId)
}

/** El tender de saldo a favor resuelto por el SERVIDOR con su revisión VIGENTE, dentro de la transacción de la devolución. */
export async function resolveStoreCreditTenderInTx(tx: Prisma.TransactionClient, venueId: string): Promise<ResolvedTenderCharge> {
  const tender = await tx.venueTenderType.findFirst({
    where: { venueId, systemKind: 'STORE_CREDIT' },
    select: { id: true, baseMethod: true, revision: true },
  })
  const revision = tender
    ? await tx.venueTenderTypeRevision.findFirst({ where: { tenderTypeId: tender.id, venueId, revision: tender.revision } })
    : null
  if (!tender || !revision) {
    throw new AppError(
      'El tipo de pago «Saldo a favor» no está listo en este negocio. Intenta de nuevo y, si sigue, avísale a soporte de Avoqado.',
      422,
      true,
      'STORE_CREDIT_TENDER_MISSING',
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
    // Nunca del cajón ni del banco: el saldo a favor no mueve dinero, sólo registra el destino de la devolución (spec §5.3).
    fundsFlow: PaymentFundsFlow.EXTERNAL_RECORDED,
  }
}
