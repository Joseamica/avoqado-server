/**
 * 1b S6: la página pública del regalo (`GET /api/v1/public/gift-cards/:pageToken`). La abre quien recibió la liga.
 *  - Todo lo que no se puede usar HOY responde EXACTO `{ disponible: false }`, igual que un token que no existe o mal formado
 *    (S-11, diseño § 6): la página no distingue «no existe» de «sin saldo».
 *  - Una tarjeta usable trae lo de la página, sin `pageToken`, `id` ni `venueId` como llaves.
 *  - Una sola lectura del sobre por `pageToken`, con su venue. Ver la página no escribe bitácora (Q102 la excluye).
 */
import { Prisma } from '@prisma/client'
import {
  decryptGiftCardCode,
  encryptGiftCardCode,
  formatGiftCardCode,
  generateGiftCardCode,
  generateOpaqueToken,
} from '@/services/giftCards/giftCardCode'
import { urlDeLaPagina } from '@/services/giftCards/giftCardEntrega'
import { getPaginaDelRegalo } from '@/services/giftCards/giftCardPublic.service'
import { prismaMock } from '../../../__helpers__/setup'

const AHORA = new Date('2026-10-21T18:00:00.000Z')
const TOKEN = generateOpaqueToken()
const codigo = generateGiftCardCode()
const CODE_ENC = encryptGiftCardCode(codigo.normalized)

const VENUE = {
  name: 'IQ Collection',
  address: 'Av. X 1',
  city: 'Lomas',
  state: 'CDMX',
  phone: '55 1234 5678',
  logo: 'https://x/logo.png',
  timezone: 'America/Mexico_City',
}

/** Lo que devolvería la base. Trae `id`, `venueId` y `pageToken` A PROPÓSITO: la respuesta no debe copiarlos. */
const sobre = (over: Record<string, unknown> = {}, venue: Record<string, unknown> = {}) => ({
  id: 'cm2k9x0ab0001c912abcdefgh',
  venueId: 'cm2k9x0ab0002c912abcdefgh',
  pageToken: TOKEN,
  codeEnc: CODE_ENC,
  codeLast4: codigo.last4,
  status: 'ACTIVE',
  balance: new Prisma.Decimal('750.50'),
  initialAmount: new Prisma.Decimal(1000),
  expiresAt: null,
  termsVersion: '2026-10-14',
  purchaserName: 'Luis',
  recipientName: 'Ana',
  message: '¡Feliz cumpleaños!',
  venue: { ...VENUE, ...venue },
  ...over,
})

/** Todas las llaves de un objeto, a cualquier profundidad. */
function llaves(valor: unknown): string[] {
  if (!valor || typeof valor !== 'object') return []
  return Object.entries(valor as Record<string, unknown>).flatMap(([k, v]) => [k, ...llaves(v)])
}

beforeEach(() => {
  prismaMock.giftCard.findUnique.mockReset().mockResolvedValue(null)
})

describe('getPaginaDelRegalo — lo que no se puede usar hoy', () => {
  it.each([
    ['un token bien formado que no existe (43 caracteres)', `no-existe-${'x'.repeat(33)}`, null],
    ['un token corto', 'abc', undefined],
    ['un token larguísimo', 'x'.repeat(200), undefined],
    ['un token con caracteres fuera de base64url', `${'a'.repeat(30)}/../${'b'.repeat(10)}`, undefined],
  ])('%s ⇒ { disponible: false } exacto', async (_caso, token, fila) => {
    if (fila !== undefined) prismaMock.giftCard.findUnique.mockResolvedValue(fila)
    const r = await getPaginaDelRegalo(token, AHORA)
    expect(r).toEqual({ disponible: false })
    expect(Object.keys(r)).toEqual(['disponible'])
    // Mal formado ⇒ ni siquiera se consulta la base.
    if (fila === undefined) expect(prismaMock.giftCard.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    ['PENDING (vendida, sin cobrar)', { status: 'PENDING' }],
    ['DEACTIVATED', { status: 'DEACTIVATED' }],
    ['BLOCKED', { status: 'BLOCKED' }],
    ['vencida (expiresAt = ahora − 1 ms)', { expiresAt: new Date(AHORA.getTime() - 1) }],
    ['ACTIVE con saldo 0', { balance: new Prisma.Decimal(0) }],
  ])('un sobre %s ⇒ { disponible: false } exacto, sin código ni datos', async (_caso, over) => {
    prismaMock.giftCard.findUnique.mockResolvedValue(sobre(over))
    const r = await getPaginaDelRegalo(TOKEN, AHORA)
    expect(r).toEqual({ disponible: false })
    expect(Object.keys(r)).toEqual(['disponible'])
  })
})

describe('getPaginaDelRegalo — una tarjeta usable', () => {
  it('una tarjeta usable trae todo lo de la página', async () => {
    prismaMock.giftCard.findUnique.mockResolvedValue(sobre())
    const r = await getPaginaDelRegalo(TOKEN, AHORA)

    expect(r).toEqual({
      disponible: true,
      negocio: { nombre: 'IQ Collection', logoUrl: 'https://x/logo.png', direccion: 'Av. X 1, Lomas, CDMX', telefono: '55 1234 5678' },
      monto: 1000,
      saldo: 750.5,
      venceEl: null,
      de: 'Luis',
      para: 'Ana',
      mensaje: '¡Feliz cumpleaños!',
      codigo: formatGiftCardCode(decryptGiftCardCode(CODE_ENC)),
      folio: codigo.last4,
      terminos: { version: '2026-10-14', texto: expect.stringContaining('Tarjeta de regalo de IQ Collection.') },
      avisoDePrivacidad: expect.stringContaining('IQ Collection es responsable de tus datos'),
    })
    if (!r.disponible) throw new Error('debía estar disponible')
    expect(r.codigo).toBe(codigo.display)
    // La liga de «Consulta tu saldo en…» SÍ lleva el token (es la misma página); por eso se miran las LLAVES, no el cuerpo.
    expect(r.terminos.texto).toContain(`Consulta tu saldo en ${urlDeLaPagina(TOKEN)}.`)
    expect(r.terminos.texto).toContain('Sin fecha de vencimiento.')
    expect(r.terminos.texto.endsWith('Av. X 1, Lomas, CDMX. 55 1234 5678.')).toBe(true)
    for (const prohibida of ['pageToken', 'id', 'venueId', 'codeEnc', 'codeHash']) expect(llaves(r)).not.toContain(prohibida)

    // Una sola lectura del sobre por su `pageToken`, con su venue.
    expect(prismaMock.giftCard.findUnique).toHaveBeenCalledTimes(1)
    expect(prismaMock.giftCard.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pageToken: TOKEN },
        select: expect.objectContaining({ venue: expect.objectContaining({ select: expect.any(Object) }) }),
      }),
    )
  })

  it('venceEl es la fecha (YYYY-MM-DD) en la zona del negocio: 2027-01-01T05:00Z en CDMX ⇒ 2026-12-31', async () => {
    prismaMock.giftCard.findUnique.mockResolvedValue(sobre({ expiresAt: new Date('2027-01-01T05:00:00.000Z') }))
    const r = await getPaginaDelRegalo(TOKEN, AHORA)
    if (!r.disponible) throw new Error('debía estar disponible')
    expect(r.venceEl).toBe('2026-12-31')
    expect(r.terminos.texto).toContain('Vence el 31 de diciembre de 2026.')
  })

  it.each([
    ['http://x/logo.png', null],
    ['https://x/logo.png', 'https://x/logo.png'],
    ['//x/logo.png', null],
    ['javascript:alert(1)', null],
    [null, null],
  ])('Venue.logo %p ⇒ logoUrl %p (sólo https://)', async (logo, esperado) => {
    prismaMock.giftCard.findUnique.mockResolvedValue(sobre({}, { logo }))
    const r = await getPaginaDelRegalo(TOKEN, AHORA)
    if (!r.disponible) throw new Error('debía estar disponible')
    expect(r.negocio.logoUrl).toBe(esperado)
  })

  it('el domicilio sólo con las partes que existen; sin ninguna, null; sin teléfono, null', async () => {
    prismaMock.giftCard.findUnique.mockResolvedValue(sobre({}, { address: 'Av. X 1', city: null, state: ' ', phone: '' }))
    const r = await getPaginaDelRegalo(TOKEN, AHORA)
    if (!r.disponible) throw new Error('debía estar disponible')
    expect(r.negocio.direccion).toBe('Av. X 1')
    expect(r.negocio.telefono).toBeNull()

    prismaMock.giftCard.findUnique.mockResolvedValue(sobre({}, { address: null, city: null, state: null, phone: null }))
    const s = await getPaginaDelRegalo(TOKEN, AHORA)
    if (!s.disponible) throw new Error('debía estar disponible')
    expect(s.negocio.direccion).toBeNull()
    expect(s.terminos.texto.endsWith(`Consulta tu saldo en ${urlDeLaPagina(TOKEN)}.`)).toBe(true)
  })

  it('de, para y mensaje ausentes ⇒ null', async () => {
    prismaMock.giftCard.findUnique.mockResolvedValue(sobre({ purchaserName: null, recipientName: '', message: null }))
    const r = await getPaginaDelRegalo(TOKEN, AHORA)
    if (!r.disponible) throw new Error('debía estar disponible')
    expect([r.de, r.para, r.mensaje]).toEqual([null, null, null])
  })

  it('sin llaves del servidor: GIFT_CARD_KEYS_MISSING sin leer la base (no delata si el token existe)', async () => {
    const antes = process.env.GIFT_CARD_CODE_KEY
    delete process.env.GIFT_CARD_CODE_KEY
    try {
      await expect(getPaginaDelRegalo(TOKEN, AHORA)).rejects.toMatchObject({ code: 'GIFT_CARD_KEYS_MISSING' })
      expect(prismaMock.giftCard.findUnique).not.toHaveBeenCalled()
      // Un token mal formado sigue siendo `{ disponible: false }`.
      await expect(getPaginaDelRegalo('abc', AHORA)).resolves.toEqual({ disponible: false })
    } finally {
      process.env.GIFT_CARD_CODE_KEY = antes
    }
  })
})
