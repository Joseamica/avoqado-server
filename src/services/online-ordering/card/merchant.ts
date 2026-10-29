// src/services/online-ordering/card/merchant.ts
import type { Prisma } from '@prisma/client'
import { isEcommerceMerchantChargeable } from '@/services/payments/ecommerceCapability'
import type { EcommerceMerchantWithProvider } from '@/services/payments/providers/provider.interface'

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
