// src/services/giftCards/giftCardCode.ts
/**
 * El código de una tarjeta de regalo (spec 2026-10-14 § 4.1): 16 caracteres Crockford Base32 al azar (80 bits) + 1 de
 * control (Luhn mod 32, detecta cualquier carácter equivocado), mostrado `XXXX-XXXX-XXXX-XXXX-X`.
 *
 * 🔴 Nunca se guarda en claro: `codeHash` (HMAC-SHA256 con `GIFT_CARD_HMAC_KEY`) para buscarlo, `codeEnc`
 * (AES-256-GCM con `GIFT_CARD_CODE_KEY`) para volver a mostrar el QR, reimprimir o reenviar. Nunca en logs.
 * Sin llaves la función se apaga con GIFT_CARD_KEYS_MISSING (R7).
 */
import crypto from 'crypto'
import { createTokenCipher } from '@/lib/token-encryption'
import { GiftCardError } from './giftCardErrors'

/** Crockford Base32: sin I, L, O ni U (se confunden al dictar o al teclear). */
export const ALFABETO_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const LARGO_AL_AZAR = 16
const LLAVE_HEX = /^[0-9a-fA-F]{64}$/

const cifrador = () => createTokenCipher('GIFT_CARD_CODE_KEY')

/** ¿Están las dos llaves con el formato correcto? */
export function giftCardKeysPresent(): boolean {
  return LLAVE_HEX.test(process.env.GIFT_CARD_CODE_KEY ?? '') && LLAVE_HEX.test(process.env.GIFT_CARD_HMAC_KEY ?? '')
}

export function assertGiftCardKeys(): void {
  if (!giftCardKeysPresent()) {
    throw new GiftCardError(
      'GIFT_CARD_KEYS_MISSING',
      'Las tarjetas de regalo no están disponibles: falta configurar las llaves del servidor. Avísale a soporte de Avoqado.',
      409,
    )
  }
}

/** Luhn mod 32 sobre el alfabeto Crockford. */
function caracterDeControl(payload: string): string {
  const n = ALFABETO_CROCKFORD.length
  let factor = 2
  let suma = 0
  for (let i = payload.length - 1; i >= 0; i--) {
    let sumando = factor * ALFABETO_CROCKFORD.indexOf(payload[i])
    factor = factor === 2 ? 1 : 2
    sumando = Math.floor(sumando / n) + (sumando % n)
    suma += sumando
  }
  return ALFABETO_CROCKFORD[(n - (suma % n)) % n]
}

export function formatGiftCardCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16)}`
}

export function generateGiftCardCode(): { normalized: string; display: string; last4: string } {
  const bytes = crypto.randomBytes(LARGO_AL_AZAR)
  let payload = ''
  // 256 es múltiplo de 32: `& 31` es uniforme sobre el alfabeto.
  for (let i = 0; i < LARGO_AL_AZAR; i++) payload += ALFABETO_CROCKFORD[bytes[i] & 31]
  const normalized = payload + caracterDeControl(payload)
  return { normalized, display: formatGiftCardCode(normalized), last4: payload.slice(12, 16) }
}

/** Quita guiones y espacios, pasa a mayúsculas, I/L → 1 y O → 0; valida alfabeto, largo y dígito de control. */
export function normalizeGiftCardCode(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const limpio = raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (limpio.length !== LARGO_AL_AZAR + 1) return null
  for (const c of limpio) if (!ALFABETO_CROCKFORD.includes(c)) return null
  return caracterDeControl(limpio.slice(0, LARGO_AL_AZAR)) === limpio[LARGO_AL_AZAR] ? limpio : null
}

export function hashGiftCardCode(normalized: string): string {
  assertGiftCardKeys()
  return crypto
    .createHmac('sha256', Buffer.from(process.env.GIFT_CARD_HMAC_KEY as string, 'hex'))
    .update(normalized)
    .digest('hex')
}

export function encryptGiftCardCode(normalized: string): string {
  assertGiftCardKeys()
  return cifrador().encryptToBase64(normalized)
}

export function decryptGiftCardCode(enc: string): string {
  assertGiftCardKeys()
  return cifrador().decryptFromBase64(enc)
}

/** 32 bytes al azar en base64url: `pageToken` y `cancelToken`. */
export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}
