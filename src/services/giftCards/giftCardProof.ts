// src/services/giftCards/giftCardProof.ts
/**
 * La prueba de posesión de un cobro con saldo (1b S2): el código (`CODE`) o la liga de la tarjeta (`PAGE_TOKEN`, Q7); S5 agrega
 * `PHONE_OTP`. Se resuelve a UN sobre del negocio antes de la transacción y se vuelve a juzgar BAJO el candado del sobre
 * (`vigente`), con la hora de la base leída con el candado de la llave (Q91). Una prueba que no nombra un sobre de este negocio
 * —mal formada o inexistente— es siempre el MISMO 404.
 */
import type { Prisma } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { hashGiftCardCode, normalizeGiftCardCode } from './giftCardCode'
import { GiftCardError } from './giftCardErrors'
import type { LockedGiftCard } from './giftCardLedger'

/** `generateOpaqueToken()` hace 43 caracteres base64url; se acepta un margen sin dejar pasar basura. */
export const PAGE_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/

export type PruebaDePosesion = { kind: 'CODE'; code: string } | { kind: 'PAGE_TOKEN'; pageToken: string }

export interface PruebaResuelta {
  giftCardId: string
  last4: string
  /** Se llama BAJO el candado del sobre: ¿la prueba sigue valiendo para la fila bloqueada? `ahora` = la hora de la base
   *  leída con el candado de la llave ya puesto (`tomarLlaveDeCobro`, Q91). CODE/PAGE_TOKEN no la usan; PHONE_OTP (S5) sí. */
  vigente(card: LockedGiftCard, ahora: Date): boolean
  /** El error si `vigente` dice que no (CODE/PAGE_TOKEN: el 404 de siempre). */
  rechazo(): GiftCardError
}

const noEncontrada = () =>
  new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio. Revisa el código.', 404)

/** Cómo nombra la prueba a su sobre: el filtro dentro del negocio y la comparación bajo el candado. `null` = no nombra ninguno. */
function busquedaDe(
  venueId: string,
  prueba: PruebaDePosesion,
): { where: Prisma.GiftCardWhereInput; vigente: (card: LockedGiftCard) => boolean } | null {
  switch (prueba?.kind) {
    case 'CODE': {
      const normalizado = normalizeGiftCardCode(prueba.code)
      if (!normalizado) return null
      const codeHash = hashGiftCardCode(normalizado)
      // r1 (A-1): si el gerente repuso el código mientras se esperaba el candado, la huella vigente ya no es la presentada.
      return { where: { venueId, codeHash }, vigente: card => card.codeHash === codeHash }
    }
    case 'PAGE_TOKEN': {
      const { pageToken } = prueba
      if (typeof pageToken !== 'string' || !PAGE_TOKEN_RE.test(pageToken)) return null
      // Reponer el código también cambia la liga: la vieja deja de servir aunque se haya resuelto antes del candado.
      return { where: { venueId, pageToken }, vigente: card => card.pageToken === pageToken }
    }
    default:
      throw new BadRequestError('Falta cómo se identificó la tarjeta: código, liga o teléfono.')
  }
}

/** El filtro del sobre de la prueba (la consulta de saldo lo usa con su propio `select`); `null` si no nombra ninguno. */
export function filtroDeLaPrueba(venueId: string, prueba: PruebaDePosesion): Prisma.GiftCardWhereInput | null {
  return busquedaDe(venueId, prueba)?.where ?? null
}

/**
 * CODE: por `codeHash`; PAGE_TOKEN: por `pageToken`; los dos dentro del venue. Sin sobre ⇒ GIFT_CARD_NOT_FOUND 404.
 * Q91: no juzga nada que cambie con el tiempo (eso es de `vigente`, bajo el candado).
 */
export async function resolverPrueba(
  venueId: string,
  prueba: PruebaDePosesion,
  _ctx: { deviceId: string | null },
): Promise<PruebaResuelta> {
  const busqueda = busquedaDe(venueId, prueba)
  const sobre = busqueda ? await prisma.giftCard.findFirst({ where: busqueda.where, select: { id: true, codeLast4: true } }) : null
  if (!busqueda || !sobre) throw noEncontrada()
  return { giftCardId: sobre.id, last4: sobre.codeLast4, vigente: card => busqueda.vigente(card), rechazo: noEncontrada }
}

/** El sobre que la prueba nombra SIN validarla (para la salida de repetición por llave). */
export async function sobreDeLaPrueba(venueId: string, prueba: PruebaDePosesion): Promise<string | null> {
  const where = filtroDeLaPrueba(venueId, prueba)
  if (!where) return null
  const sobre = await prisma.giftCard.findFirst({ where, select: { id: true } })
  return sobre?.id ?? null
}
