// src/services/giftCards/cuentaDeTarjetas.ts
/**
 * La cuenta de tarjetas (R11): una `Order` con al menos una línea con `giftCardId` y ninguna sin él. El servidor rechaza
 * sobre ella productos, descuentos, cortesías, premios, promociones, cargos, cambios de precio o cantidad, divisiones y
 * uniones — también si lo pide una app vieja o la cola sin red (spec § 4.4). Módulo LIVIANO a propósito: lo importan los
 * nueve servicios de órdenes, así que no carga nada de ellos.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { GiftCardError } from './giftCardErrors'

export { desactivarSobresPendientesDeCuentaEnTx } from './giftCardLedger'

/** La definición de R11 (TODAS las líneas son de tarjeta). Para GUARDAR una escritura usa `tieneRenglonDeTarjeta`. */
export function esCuentaDeTarjetas(items: ReadonlyArray<{ giftCardId: string | null }>): boolean {
  return items.length > 0 && items.every(item => item.giftCardId != null)
}

// N1 (cierre): vive en un módulo sin Prisma (`giftCardPredicados`) para quien no puede cargar el cliente; aquí se re-exporta.
export { tieneRenglonDeTarjeta } from './giftCardPredicados'

/** ¿La cuenta tiene líneas de tarjeta? Las líneas de tarjeta sólo nacen con la cuenta: nunca se agregan después. */
export async function esCuentaDeTarjetasEnTx(db: Prisma.TransactionClient | PrismaClient, orderId: string): Promise<boolean> {
  const renglon = await db.orderItem.findFirst({
    where: { orderId, giftCardId: { not: null } },
    select: { giftCardId: true },
  })
  return renglon?.giftCardId != null
}

export async function rechazarSiEsCuentaDeTarjetas(
  db: Prisma.TransactionClient | PrismaClient,
  orderId: string,
  accion: string,
): Promise<void> {
  if (await esCuentaDeTarjetasEnTx(db, orderId)) {
    throw new GiftCardError(
      'GIFT_CARD_ORDER_IMMUTABLE',
      `Esta cuenta es de tarjetas de regalo y no admite ${accion}. Si hay un error, cancélala y crea otra.`,
      409,
      { orderId },
    )
  }
}
