// src/services/giftCards/giftCardPredicados.ts
/**
 * Predicados PUROS de tarjetas de regalo, sin un solo import: los usan módulos que no pueden cargar Prisma al cargarse.
 * 🔴 N1 (cierre de tarjetas 1a): `scripts/reasignar-cobro-a-su-orden.ts` elige la base ANTES de cargar Prisma; un import que
 * arrastrara `src/utils/prismaClient` construiría el cliente con la URL del `.env` y el script escribiría en otra base de la que
 * confirma. No importes servicios aquí (lo vigila `tests/unit/architecture/grafoDeImports.guard.test.ts`).
 */

/** ¿El tender es el de sistema «Tarjeta de regalo» (`systemKind = GIFT_CARD`)? */
export function isGiftCardTenderKind(systemKind: string | null | undefined): boolean {
  return systemKind === 'GIFT_CARD'
}

/**
 * ¿Alguna línea es de tarjeta? Es la versión en memoria de `esCuentaDeTarjetasEnTx` y la que usan las guardias: basta UNA
 * línea de tarjeta para no tocar la cuenta (defensa en profundidad si alguna vez quedara mezclada).
 */
export function tieneRenglonDeTarjeta(items: ReadonlyArray<{ giftCardId: string | null }>): boolean {
  return items.some(item => item.giftCardId != null)
}
