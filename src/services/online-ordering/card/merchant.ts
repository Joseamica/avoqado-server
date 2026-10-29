// src/services/online-ordering/card/merchant.ts
import type { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { isEcommerceMerchantChargeable } from '@/services/payments/ecommerceCapability'
import type { EcommerceMerchantWithProvider, VerifiedWebhookEvent } from '@/services/payments/providers/provider.interface'
import { stripeServerLivemode } from '@/services/payments/providers/stripe-connect.provider'

const STRIPE_CONNECT = 'STRIPE_CONNECT'

/** Lo que el borrador copia del comercio al nacer (`OnlineOrderCharge.merchantSnapshot`). */
export interface MerchantSnapshot {
  connectAccountId: string
  sandboxMode: boolean
  providerCode: string
}

/** Los comercios Stripe Connect activos del negocio, el más nuevo primero (tope 5). */
async function listStripeMerchants(db: Prisma.TransactionClient, venueId: string) {
  return db.ecommerceMerchant.findMany({
    where: { venueId, active: true, provider: { code: STRIPE_CONNECT, active: true } },
    include: { provider: { select: { code: true } } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
}

/** El comercio Stripe Connect activo y cobrable del negocio, el más nuevo; `null` si no hay. */
export async function findCardMerchant(
  db: Prisma.TransactionClient,
  venueId: string,
): Promise<(EcommerceMerchantWithProvider & { id: string; platformFeeBps: number }) | null> {
  const merchants = await listStripeMerchants(db, venueId)
  return merchants.find(m => isEcommerceMerchantChargeable(m)) ?? null
}

export type CardMerchantStatus = 'NOT_CONNECTED' | 'NOT_CHARGEABLE' | 'READY'

/** Para el panel: ninguna cuenta Stripe, una que aún no puede cobrar, o lista; una sola consulta, mismo criterio que `findCardMerchant`. */
export async function cardMerchantStatus(db: Prisma.TransactionClient, venueId: string): Promise<CardMerchantStatus> {
  const merchants = await listStripeMerchants(db, venueId)
  if (merchants.length === 0) return 'NOT_CONNECTED'
  return merchants.some(m => isEcommerceMerchantChargeable(m)) ? 'READY' : 'NOT_CHARGEABLE'
}

/**
 * Codex r2 #3: el comercio armado desde la FOTO del cargo, nunca desde el comercio vivo. Capturar, liberar, leer y devolver
 * usan siempre éste: la cuenta Stripe del cargo no cambia aunque el comercio cambie sus credenciales después.
 */
export function chargeMerchant(charge: { ecommerceMerchantId: string; merchantSnapshot: Prisma.JsonValue }): EcommerceMerchantWithProvider {
  const snap = charge.merchantSnapshot as unknown as MerchantSnapshot | null
  if (snap?.providerCode !== STRIPE_CONNECT || !snap.connectAccountId) {
    throw new Error(`Cargo de pedido en línea con un comercio que no es Stripe Connect: ${snap?.providerCode ?? 'sin foto'}`)
  }
  return {
    id: charge.ecommerceMerchantId,
    providerCredentials: { connectAccountId: snap.connectAccountId },
    sandboxMode: snap.sandboxMode,
    provider: { code: STRIPE_CONNECT },
  }
}

/**
 * Codex r1 C2: un aviso de Stripe sólo sirve para ENCONTRAR el cargo. Si no viene de la cuenta conectada de su foto, o del modo
 * (real/prueba) de la llave del servidor (r2 R3), no se escribe nada: `MoneyAnomaly` (una por aviso) y 🚨. `true` = el aviso es de otra cuenta.
 */
export async function isForeignStripeEvent(
  event: Pick<VerifiedWebhookEvent, 'id' | 'type' | 'account' | 'livemode'>,
  charge: { id: string; venueId: string; merchantSnapshot: Prisma.JsonValue },
): Promise<boolean> {
  const snap = charge.merchantSnapshot as unknown as MerchantSnapshot | null
  // r2 R3: el modo es el de la llave del servidor (lo que de verdad usa el proveedor), no `sandboxMode` de la foto (editable).
  const livemode = stripeServerLivemode()
  const ours = !!snap?.connectAccountId && event.account === snap.connectAccountId && event.livemode === livemode
  if (ours) return false
  const observed = { eventId: event.id, type: event.type, account: event.account ?? null, livemode: event.livemode }
  const expected = {
    venueId: charge.venueId,
    chargeId: charge.id,
    account: snap?.connectAccountId ?? null,
    livemode,
  }
  logger.error('🚨 [OnlineOrderCard] aviso de Stripe de otra cuenta o de otro modo sobre un cargo: no se escribe nada', {
    ...expected,
    ...observed,
  })
  await prisma.moneyAnomaly.createMany({
    data: [{ category: 'ONLINE_ORDER_STRIPE_EVENT_FOREIGN', stripeEventId: event.id, expectedState: expected, observedState: observed }],
    skipDuplicates: true,
  })
  return true
}
