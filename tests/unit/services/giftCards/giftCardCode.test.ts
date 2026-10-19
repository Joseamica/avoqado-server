import {
  ALFABETO_CROCKFORD,
  decryptGiftCardCode,
  encryptGiftCardCode,
  formatGiftCardCode,
  generateGiftCardCode,
  generateOpaqueToken,
  giftCardKeysPresent,
  hashGiftCardCode,
  normalizeGiftCardCode,
} from '@/services/giftCards/giftCardCode'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'

function errorDe(fn: () => unknown): GiftCardError {
  try {
    fn()
  } catch (e) {
    return e as GiftCardError
  }
  throw new Error('se esperaba que lanzara')
}

describe('giftCardCode — el código de la tarjeta', () => {
  it('genera 16 caracteres Crockford al azar + 1 de control; se muestra XXXX-XXXX-XXXX-XXXX-X', () => {
    const c = generateGiftCardCode()
    expect(c.normalized).toMatch(/^[0-9A-HJKMNP-TV-Z]{17}$/)
    expect(c.display).toBe(
      `${c.normalized.slice(0, 4)}-${c.normalized.slice(4, 8)}-${c.normalized.slice(8, 12)}-${c.normalized.slice(12, 16)}-${c.normalized.slice(16)}`,
    )
    expect(c.last4).toBe(c.normalized.slice(12, 16))
    expect(normalizeGiftCardCode(c.display)).toBe(c.normalized)
  })

  it('no repite en 2,000 códigos (80 bits al azar)', () => {
    const vistos = new Set(Array.from({ length: 2000 }, () => generateGiftCardCode().normalized))
    expect(vistos.size).toBe(2000)
  })

  it('normaliza lo que teclea una persona: minúsculas, espacios, guiones, I/L → 1 y O → 0', () => {
    const payload = 'A1B0C1D0E1F0G1H0'
    const valido = [...ALFABETO_CROCKFORD].map(ch => payload + ch).find(c => normalizeGiftCardCode(c) !== null)
    expect(valido).toBeDefined()
    const tecleado = (valido as string).toLowerCase().replace(/1/g, 'l').replace(/0/g, 'o')
    expect(normalizeGiftCardCode(` ${tecleado.slice(0, 4)}-${tecleado.slice(4, 8)} ${tecleado.slice(8)} `)).toBe(valido)
    expect(normalizeGiftCardCode((valido as string).replace(/1/g, 'I'))).toBe(valido)
  })

  it('un carácter equivocado al teclear no pasa el dígito de control', () => {
    const c = generateGiftCardCode()
    for (const i of [0, 5, 11, 15]) {
      const otro = ALFABETO_CROCKFORD[(ALFABETO_CROCKFORD.indexOf(c.normalized[i]) + 1) % ALFABETO_CROCKFORD.length]
      expect(normalizeGiftCardCode(c.normalized.slice(0, i) + otro + c.normalized.slice(i + 1))).toBeNull()
    }
  })

  it('rechaza largo distinto, la U y caracteres fuera del alfabeto', () => {
    const c = generateGiftCardCode()
    expect(normalizeGiftCardCode(c.normalized.slice(0, 16))).toBeNull()
    expect(normalizeGiftCardCode(c.normalized + 'A')).toBeNull()
    expect(normalizeGiftCardCode(c.normalized.slice(0, 16) + 'U')).toBeNull()
    expect(normalizeGiftCardCode(c.normalized.slice(0, 16) + '*')).toBeNull()
    expect(normalizeGiftCardCode('')).toBeNull()
  })

  it('formatGiftCardCode arma grupos de 4 y el control al final', () => {
    expect(formatGiftCardCode('ABCDEFGHJKMNPQRS7')).toBe('ABCD-EFGH-JKMN-PQRS-7')
  })

  it('la huella es HMAC-SHA256 en hex, determinista, y cambia si cambia la llave', () => {
    const h = hashGiftCardCode('ABCDEFGHJKMNPQRS7')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashGiftCardCode('ABCDEFGHJKMNPQRS7')).toBe(h)
    const antes = process.env.GIFT_CARD_HMAC_KEY
    process.env.GIFT_CARD_HMAC_KEY = 'e'.repeat(64)
    try {
      expect(hashGiftCardCode('ABCDEFGHJKMNPQRS7')).not.toBe(h)
    } finally {
      process.env.GIFT_CARD_HMAC_KEY = antes
    }
  })

  it('cifra y descifra; el cifrado nunca contiene el código y cambia en cada llamada (IV al azar)', () => {
    const c = generateGiftCardCode()
    const enc = encryptGiftCardCode(c.normalized)
    expect(enc).not.toContain(c.normalized)
    expect(decryptGiftCardCode(enc)).toBe(c.normalized)
    expect(encryptGiftCardCode(c.normalized)).not.toBe(enc)
  })

  it('sin llaves la función se apaga con GIFT_CARD_KEYS_MISSING, nunca con un 500 genérico', () => {
    const antes = process.env.GIFT_CARD_CODE_KEY
    delete process.env.GIFT_CARD_CODE_KEY
    try {
      expect(giftCardKeysPresent()).toBe(false)
      expect(errorDe(() => encryptGiftCardCode('X')).code).toBe('GIFT_CARD_KEYS_MISSING')
      expect(errorDe(() => hashGiftCardCode('X')).code).toBe('GIFT_CARD_KEYS_MISSING')
      expect(errorDe(() => hashGiftCardCode('X')).statusCode).toBe(409)
    } finally {
      process.env.GIFT_CARD_CODE_KEY = antes
    }
    expect(giftCardKeysPresent()).toBe(true)
  })

  it('el token opaco es base64url de 32 bytes y no se repite', () => {
    const a = generateOpaqueToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateOpaqueToken()).not.toBe(a)
  })
})
