// src/services/giftCards/giftCardProof.ts
/**
 * La prueba de posesión de un cobro con saldo (1b S2): el código (`CODE`), la liga de la tarjeta (`PAGE_TOKEN`, Q7) o, desde S5,
 * el teléfono verificado con un código de un solo uso (`PHONE_OTP`, Q6). Se resuelve a UN sobre del negocio antes de la
 * transacción y se vuelve a juzgar BAJO el candado del sobre (`vigente`), con la hora de la base leída con el candado de la llave
 * (Q91). Una prueba que no nombra un sobre de este negocio —mal formada o inexistente— es siempre el MISMO 404.
 */
import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import { BadRequestError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { assertGiftCardKeys, hashGiftCardCode, normalizeGiftCardCode } from './giftCardCode'
import { telefonoDeTarjeta } from './giftCardEntrega'
import { GiftCardError } from './giftCardErrors'
import type { LockedGiftCard } from './giftCardLedger'

/** `generateOpaqueToken()` hace 43 caracteres base64url; se acepta un margen sin dejar pasar basura. */
export const PAGE_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/

export type PruebaDePosesion =
  | { kind: 'CODE'; code: string }
  | { kind: 'PAGE_TOKEN'; pageToken: string }
  | { kind: 'PHONE_OTP'; proofToken: string; giftCardId: string }

export interface PruebaResuelta {
  giftCardId: string
  last4: string
  /** Se llama BAJO el candado del sobre: ¿la prueba sigue valiendo para la fila bloqueada? `ahora` = la hora de la base
   *  leída con el candado de la llave ya puesto (`tomarLlaveDeCobro`, Q91). CODE/PAGE_TOKEN no la usan; PHONE_OTP sí. */
  vigente(card: LockedGiftCard, ahora: Date): boolean
  /** El error si `vigente` dice que no (CODE/PAGE_TOKEN: el 404 de siempre; PHONE_OTP: GIFT_CARD_PHONE_PROOF_INVALID). */
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
    case 'PHONE_OTP': {
      // El sobre lo eligió la caja de la lista de `phone/verify` (Q13); que sea de ESE teléfono lo juzga `vigente` bajo el candado.
      const { giftCardId } = prueba
      if (typeof giftCardId !== 'string' || !giftCardId) return null
      return { where: { venueId, id: giftCardId }, vigente: () => true }
    }
    default:
      throw new BadRequestError('Falta cómo se identificó la tarjeta: código, liga o teléfono.')
  }
}

/**
 * El filtro del sobre de la prueba (la consulta de saldo lo usa con su propio `select`); `null` si no nombra ninguno.
 * 🔴 Con PHONE_OTP este filtro sólo NOMBRA el sobre (`giftCardId`): NO valida la prueba. La prueba de teléfono se valida aparte:
 * `resolverPrueba` lee su firma, venue y aparato, y `vigente` juzga su vigencia y su teléfono bajo el candado del sobre (Q91). Hoy
 * sólo lo usa así `sobreDeLaPrueba`, para la salida de repetición por llave: lee sólo el `id` del sobre para compararlo con el cobro
 * ya hecho con esa llave (ni saldo ni datos); por eso esta rama no lanza. Nunca lo uses con PHONE_OTP para leer o mostrar un sobre: sería
 * leerlo sin prueba. Para eso está `resolverPrueba`.
 */
export function filtroDeLaPrueba(venueId: string, prueba: PruebaDePosesion): Prisma.GiftCardWhereInput | null {
  return busquedaDe(venueId, prueba)?.where ?? null
}

/**
 * CODE: por `codeHash`; PAGE_TOKEN: por `pageToken`; PHONE_OTP: por `giftCardId`, con su prueba firmada leída aquí (firma, venue
 * y aparato). Todos dentro del venue. Sin sobre ⇒ GIFT_CARD_NOT_FOUND 404.
 * Q91: no juzga nada que cambie con el tiempo (la vigencia de PHONE_OTP y su teléfono son de `vigente`, bajo el candado).
 */
export async function resolverPrueba(venueId: string, prueba: PruebaDePosesion, ctx: { deviceId: string | null }): Promise<PruebaResuelta> {
  const busqueda = busquedaDe(venueId, prueba)
  const telefono = prueba?.kind === 'PHONE_OTP' ? leerPruebaDeTelefono(prueba.proofToken, { venueId, deviceId: ctx.deviceId }) : null
  const sobre = busqueda ? await prisma.giftCard.findFirst({ where: busqueda.where, select: { id: true, codeLast4: true } }) : null
  if (!busqueda || !sobre) throw noEncontrada()
  if (telefono) {
    return {
      giftCardId: sobre.id,
      last4: sobre.codeLast4,
      // Cambiar el destino (S4) cambia el teléfono o el canal: la prueba del teléfono viejo deja de servir.
      vigente: (card, ahora) =>
        ahora.getTime() < telefono.expiresAt.getTime() &&
        card.deliveryChannel === 'WHATSAPP' &&
        telefonoDeTarjeta(card.recipientPhone) === telefono.phone,
      rechazo: pruebaDeTelefonoInvalida,
    }
  }
  return { giftCardId: sobre.id, last4: sobre.codeLast4, vigente: card => busqueda.vigente(card), rechazo: noEncontrada }
}

/** El sobre que la prueba nombra SIN validarla (para la salida de repetición por llave). PHONE_OTP: `prueba.giftCardId`. */
export async function sobreDeLaPrueba(venueId: string, prueba: PruebaDePosesion): Promise<string | null> {
  const where = filtroDeLaPrueba(venueId, prueba)
  if (!where) return null
  const sobre = await prisma.giftCard.findFirst({ where, select: { id: true } })
  return sobre?.id ?? null
}

// ─── 1b S5 (Q6): la prueba de teléfono, sin estado ───

/** Lo que vale la prueba que entrega `phone/verify`. */
export const PRUEBA_DE_TELEFONO_MS = 15 * 60_000
/** El propósito va DENTRO de lo firmado: una firma con la misma llave para otra cosa nunca pasa por prueba de teléfono. */
const PROPOSITO_DE_LA_FIRMA = 'gift-card-phone-proof:'

const pruebaDeTelefonoInvalida = () =>
  new GiftCardError('GIFT_CARD_PHONE_PROOF_INVALID', 'La verificación por teléfono venció. Pide otro código.', 409)

function firmar(carga: string): string {
  assertGiftCardKeys()
  return crypto
    .createHmac('sha256', Buffer.from(process.env.GIFT_CARD_HMAC_KEY as string, 'hex'))
    .update(PROPOSITO_DE_LA_FIRMA + carga)
    .digest('base64url')
}

/** `base64url(JSON { v: 1, venueId, phone, deviceId, exp })` + `.` + `base64url(HMAC)`. `phone` ya es `telefonoDeTarjeta(…)`. */
export function firmarPruebaDeTelefono(p: { venueId: string; phone: string; deviceId: string; ahora?: Date }): {
  proofToken: string
  expiresAt: Date
} {
  const expiresAt = new Date((p.ahora ?? new Date()).getTime() + PRUEBA_DE_TELEFONO_MS)
  const carga = Buffer.from(
    JSON.stringify({ v: 1, venueId: p.venueId, phone: p.phone, deviceId: p.deviceId, exp: expiresAt.getTime() }),
  ).toString('base64url')
  return { proofToken: `${carga}.${firmar(carga)}`, expiresAt }
}

/**
 * Firma, venue y aparato (la vigencia la juzga `vigente(card, ahora)` bajo el candado de la llave, Q91); cualquier falla ⇒
 * GiftCardError('GIFT_CARD_PHONE_PROOF_INVALID', 'La verificación por teléfono venció. Pide otro código.', 409). Sin llaves ⇒
 * GIFT_CARD_KEYS_MISSING. La firma se compara como TEXTO (con `timingSafeEqual`): decodificarla dejaría pasar un último carácter
 * distinto que da los mismos bytes.
 */
export function leerPruebaDeTelefono(
  proofToken: string,
  esperado: { venueId: string; deviceId: string | null },
): { phone: string; expiresAt: Date } {
  assertGiftCardKeys()
  const partes = typeof proofToken === 'string' ? proofToken.split('.') : []
  if (partes.length !== 2) throw pruebaDeTelefonoInvalida()
  const [carga, firma] = partes
  const recibida = Buffer.from(firma)
  const esperada = Buffer.from(firmar(carga))
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) throw pruebaDeTelefonoInvalida()
  let datos: { v?: unknown; venueId?: unknown; phone?: unknown; deviceId?: unknown; exp?: unknown }
  try {
    datos = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'))
  } catch {
    throw pruebaDeTelefonoInvalida()
  }
  if (
    datos?.v !== 1 ||
    datos.venueId !== esperado.venueId ||
    !esperado.deviceId ||
    datos.deviceId !== esperado.deviceId ||
    typeof datos.phone !== 'string' ||
    typeof datos.exp !== 'number'
  ) {
    throw pruebaDeTelefonoInvalida()
  }
  return { phone: datos.phone, expiresAt: new Date(datos.exp) }
}
