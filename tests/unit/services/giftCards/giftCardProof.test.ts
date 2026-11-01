/**
 * 1b S5 (Q6, Q91): la prueba de teléfono que entrega `phone/verify`. Sin estado: `base64url(carga) + '.' + base64url(HMAC)`. Se
 * lee fuera del candado (firma, venue y aparato: lo que no cambia entre un envío y su reintento) y su vigencia y su teléfono se
 * juzgan bajo el candado del sobre (`vigente(card, ahora)`), con la hora de la base.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import {
  PRUEBA_DE_TELEFONO_MS,
  firmarPruebaDeTelefono,
  leerPruebaDeTelefono,
  resolverPrueba,
  sobreDeLaPrueba,
} from '@/services/giftCards/giftCardProof'
import type { LockedGiftCard } from '@/services/giftCards/giftCardLedger'

const VENUE = 'cvenue000000000000000000a'
const OTRO_VENUE = 'cvenue000000000000000000b'
const TELEFONO = '+525512345678'
const APARATO = 'caja-1'
const EMISION = new Date('2026-10-21T18:00:00.000Z')

const errorDe = (fn: () => unknown): any => {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('no lanzó')
}
const INVALIDA = {
  code: 'GIFT_CARD_PHONE_PROOF_INVALID',
  statusCode: 409,
  message: 'La verificación por teléfono venció. Pide otro código.',
}

const firmada = (over: Partial<Parameters<typeof firmarPruebaDeTelefono>[0]> = {}) =>
  firmarPruebaDeTelefono({ venueId: VENUE, phone: TELEFONO, deviceId: APARATO, ahora: EMISION, ...over })

const sobre = (over: Partial<LockedGiftCard> = {}): LockedGiftCard =>
  ({
    id: 'cgift0000000000000000000a',
    venueId: VENUE,
    codeHash: 'h',
    pageToken: 'p',
    recipientPhone: TELEFONO,
    deliveryChannel: 'WHATSAPP',
    status: 'ACTIVE',
    ...over,
  }) as LockedGiftCard

describe('prueba de teléfono (1b S5, Q6)', () => {
  it('ida y vuelta: lo firmado se lee con su teléfono y su vencimiento (15 min)', () => {
    const { proofToken, expiresAt } = firmada()
    expect(expiresAt.getTime()).toBe(EMISION.getTime() + PRUEBA_DE_TELEFONO_MS)
    expect(PRUEBA_DE_TELEFONO_MS).toBe(15 * 60_000)
    expect(proofToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    expect(leerPruebaDeTelefono(proofToken, { venueId: VENUE, deviceId: APARATO })).toEqual({ phone: TELEFONO, expiresAt })
  })

  it('🔴 Q91: leer NO mira la hora — una prueba vencida hace un día se lee con su expiresAt (la vigencia es de `vigente`)', () => {
    const ayer = new Date(Date.now() - 24 * 3_600_000)
    const { proofToken, expiresAt } = firmada({ ahora: ayer })
    expect(leerPruebaDeTelefono(proofToken, { venueId: VENUE, deviceId: APARATO })).toEqual({ phone: TELEFONO, expiresAt })
  })

  it('otro aparato (o sin aparato) ⇒ GIFT_CARD_PHONE_PROOF_INVALID', () => {
    const { proofToken } = firmada()
    expect(errorDe(() => leerPruebaDeTelefono(proofToken, { venueId: VENUE, deviceId: 'caja-2' }))).toMatchObject(INVALIDA)
    expect(errorDe(() => leerPruebaDeTelefono(proofToken, { venueId: VENUE, deviceId: null }))).toMatchObject(INVALIDA)
  })

  it('otro venue ⇒ GIFT_CARD_PHONE_PROOF_INVALID', () => {
    const { proofToken } = firmada()
    expect(errorDe(() => leerPruebaDeTelefono(proofToken, { venueId: OTRO_VENUE, deviceId: APARATO }))).toMatchObject(INVALIDA)
  })

  it('🔴 la firma alterada en CUALQUIER carácter (también el último, el que decodifica a los mismos bytes) ⇒ inválida', () => {
    const { proofToken } = firmada()
    const [carga, firma] = proofToken.split('.')
    for (let i = 0; i < firma.length; i++) {
      const otro = firma[i] === 'A' ? 'B' : 'A'
      const alterada = `${carga}.${firma.slice(0, i)}${otro}${firma.slice(i + 1)}`
      expect({ i, error: errorDe(() => leerPruebaDeTelefono(alterada, { venueId: VENUE, deviceId: APARATO })).code }).toEqual({
        i,
        error: 'GIFT_CARD_PHONE_PROOF_INVALID',
      })
    }
  })

  it('🔴 la carga alterada (otro teléfono) con la firma vieja ⇒ inválida', () => {
    const { proofToken } = firmada()
    const [carga, firma] = proofToken.split('.')
    const datos = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'))
    const ajena = Buffer.from(JSON.stringify({ ...datos, phone: '+525599999999' })).toString('base64url')
    expect(errorDe(() => leerPruebaDeTelefono(`${ajena}.${firma}`, { venueId: VENUE, deviceId: APARATO }))).toMatchObject(INVALIDA)
  })

  it.each([['basura'], ['a.b.c'], [''], [undefined as unknown as string]])('un proofToken mal formado (%s) ⇒ inválida', token => {
    expect(errorDe(() => leerPruebaDeTelefono(token, { venueId: VENUE, deviceId: APARATO }))).toMatchObject(INVALIDA)
  })

  it('sin llaves ⇒ GIFT_CARD_KEYS_MISSING, al firmar y al leer', () => {
    const { proofToken } = firmada()
    const antes = process.env.GIFT_CARD_HMAC_KEY
    delete process.env.GIFT_CARD_HMAC_KEY
    try {
      expect(errorDe(() => firmada()).code).toBe('GIFT_CARD_KEYS_MISSING')
      expect(errorDe(() => leerPruebaDeTelefono(proofToken, { venueId: VENUE, deviceId: APARATO })).code).toBe('GIFT_CARD_KEYS_MISSING')
    } finally {
      process.env.GIFT_CARD_HMAC_KEY = antes
    }
  })
})

describe('PHONE_OTP en resolverPrueba (1b S5)', () => {
  beforeEach(() => {
    prismaMock.giftCard.findFirst.mockReset()
    prismaMock.giftCard.findFirst.mockResolvedValue({ id: 'cgift0000000000000000000a', codeLast4: 'JKMN' } as any)
  })
  const prueba = (proofToken: string) => ({ kind: 'PHONE_OTP' as const, proofToken, giftCardId: 'cgift0000000000000000000a' })

  it('el sobre es el `giftCardId` de la prueba, dentro del venue (también para la salida por llave)', async () => {
    const { proofToken } = firmada()
    const r = await resolverPrueba(VENUE, prueba(proofToken), { deviceId: APARATO })
    expect(r).toMatchObject({ giftCardId: 'cgift0000000000000000000a', last4: 'JKMN' })
    expect(prismaMock.giftCard.findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE, id: 'cgift0000000000000000000a' })
    await expect(sobreDeLaPrueba(VENUE, prueba(proofToken))).resolves.toBe('cgift0000000000000000000a')
    expect(prismaMock.giftCard.findFirst.mock.calls[1][0].where).toEqual({ venueId: VENUE, id: 'cgift0000000000000000000a' })
  })

  it('🔴 vigente(card, emisión + 15 min − 1 ms) ⇒ true; con + 15 min ⇒ false; con + 15 min + 1 ms ⇒ false', async () => {
    const { proofToken } = firmada()
    const r = await resolverPrueba(VENUE, prueba(proofToken), { deviceId: APARATO })
    const en = (ms: number) => new Date(EMISION.getTime() + PRUEBA_DE_TELEFONO_MS + ms)
    expect(r.vigente(sobre(), en(-1))).toBe(true)
    expect(r.vigente(sobre(), en(0))).toBe(false)
    expect(r.vigente(sobre(), en(1))).toBe(false)
    expect(r.rechazo()).toMatchObject(INVALIDA)
  })

  it('🔴 vigente compara el teléfono VIGENTE de la fila (bajo el candado): otro teléfono, otro canal o sin teléfono ⇒ false', async () => {
    const { proofToken } = firmada()
    const r = await resolverPrueba(VENUE, prueba(proofToken), { deviceId: APARATO })
    const antes = new Date(EMISION.getTime() + 60_000)
    expect(r.vigente(sobre({ recipientPhone: '5512345678' }), antes)).toBe(true) // fila de la 1a sin normalizar (Q25)
    expect(r.vigente(sobre({ recipientPhone: '+525599999999' }), antes)).toBe(false)
    expect(r.vigente(sobre({ deliveryChannel: 'EMAIL' }), antes)).toBe(false)
    expect(r.vigente(sobre({ recipientPhone: null }), antes)).toBe(false)
  })

  it('una prueba de otro aparato se rechaza ANTES de leer el sobre (no cambia entre un envío y su reintento)', async () => {
    const { proofToken } = firmada()
    await expect(resolverPrueba(VENUE, prueba(proofToken), { deviceId: 'caja-2' })).rejects.toMatchObject(INVALIDA)
    expect(prismaMock.giftCard.findFirst).not.toHaveBeenCalled()
  })

  it('una prueba vencida se RESUELVE (no mira la hora): el rechazo, si toca, lo da `vigente` bajo el candado', async () => {
    const { proofToken } = firmada({ ahora: new Date(Date.now() - 24 * 3_600_000) })
    await expect(resolverPrueba(VENUE, prueba(proofToken), { deviceId: APARATO })).resolves.toMatchObject({ last4: 'JKMN' })
  })
})
