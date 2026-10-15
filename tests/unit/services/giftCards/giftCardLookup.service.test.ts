import { Prisma } from '@prisma/client'
import { generateGiftCardCode } from '@/services/giftCards/giftCardCode'
import { lookupGiftCardsByCode, reiniciarLimiteDeConsultasParaPruebas } from '@/services/giftCards/giftCardLookup.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const AHORA = new Date('2026-10-14T18:00:00.000Z')
const codigo = generateGiftCardCode()
const SELECT = { id: true, codeLast4: true, status: true, balance: true, expiresAt: true }

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers({ now: AHORA, doNotFake: ['nextTick', 'setImmediate'] })
  reiniciarLimiteDeConsultasParaPruebas()
  prismaMock.giftCard.findFirst.mockReset().mockResolvedValue(null)
})
afterEach(() => jest.useRealTimers())

const sobre = (over: Record<string, unknown> = {}) => ({
  id: 'gc-1',
  codeLast4: codigo.last4,
  status: 'ACTIVE',
  balance: new Prisma.Decimal(750),
  expiresAt: new Date('2027-10-14T18:00:00.000Z'),
  ...over,
})

describe('lookupGiftCardsByCode', () => {
  it('un código mal formado es 404 GIFT_CARD_NOT_FOUND sin consultar la base', async () => {
    await expect(lookupGiftCardsByCode(VENUE, 'NO-ES-UN-CODIGO', { deviceId: 'dev-1' })).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
    expect(prismaMock.giftCard.findFirst).not.toHaveBeenCalled()
  })

  it('un código bien formado que no existe en ESTE negocio es el mismo 404', async () => {
    await expect(lookupGiftCardsByCode(VENUE, codigo.display, { deviceId: 'dev-1' })).rejects.toMatchObject({
      code: 'GIFT_CARD_NOT_FOUND',
      statusCode: 404,
    })
    expect(prismaMock.giftCard.findFirst).toHaveBeenCalledWith({
      where: { venueId: VENUE, codeHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      select: SELECT,
    })
  })

  it('un sobre activo con saldo: saldo usable y el sobre con su estado (últimos 4, saldo, vence)', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(sobre())
    await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).resolves.toEqual({
      usableBalance: 750,
      cards: [
        {
          giftCardId: 'gc-1',
          last4: codigo.last4,
          balance: 750,
          status: 'ACTIVE',
          expiresAt: '2027-10-14T18:00:00.000Z',
          usable: true,
          notUsableReason: null,
        },
      ],
    })
  })

  it.each([
    ['vendido sin cobrar', { status: 'PENDING', balance: new Prisma.Decimal(0), expiresAt: null }, 'PENDING'],
    ['bloqueado', { status: 'BLOCKED', balance: new Prisma.Decimal(500) }, 'BLOCKED'],
    ['cancelado', { status: 'DEACTIVATED', balance: new Prisma.Decimal(0) }, 'DEACTIVATED'],
    ['vencido', { expiresAt: new Date('2026-10-01T18:00:00.000Z') }, 'EXPIRED'],
    ['sin saldo', { balance: new Prisma.Decimal(0) }, 'EMPTY'],
  ])('🔴 un sobre %s se enseña con su motivo y saldo usable 0', async (_caso, over, motivo) => {
    prismaMock.giftCard.findFirst.mockResolvedValue(sobre(over))
    const r = await lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })
    expect(r.usableBalance).toBe(0)
    expect(r.cards).toEqual([expect.objectContaining({ giftCardId: 'gc-1', usable: false, notUsableReason: motivo })])
  })

  it('límite de FALLOS por aparato: el 21.º código no encontrado en 10 minutos es 429; otro aparato sigue; a los 10 minutos se libera', async () => {
    for (let i = 0; i < 20; i++) {
      await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).rejects.toMatchObject({ statusCode: 404 })
    }
    await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).rejects.toMatchObject({
      statusCode: 429,
      code: 'GIFT_CARD_LOOKUP_RATE_LIMITED',
      details: { retryAfter: 600 },
    })
    await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-2' })).rejects.toMatchObject({ statusCode: 404 })
    jest.setSystemTime(new Date(AHORA.getTime() + 10 * 60 * 1000 + 1))
    await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('las consultas que SÍ encuentran la tarjeta no cuentan como fallos', async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue(sobre())
    for (let i = 0; i < 30; i++) await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).resolves.toBeDefined()
  })

  it('límite de fallos por IP: 40 en 10 minutos aunque cambie el aparato', async () => {
    for (let i = 0; i < 40; i++) {
      await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: `dev-${i}`, ip: '10.0.0.7' })).rejects.toMatchObject({
        statusCode: 404,
      })
    }
    await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-nuevo', ip: '10.0.0.7' })).rejects.toMatchObject({
      statusCode: 429,
      code: 'GIFT_CARD_LOOKUP_RATE_LIMITED',
    })
  })

  it('un intento rechazado por el límite no consulta la base', async () => {
    for (let i = 0; i < 20; i++) await lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' }).catch(() => undefined)
    prismaMock.giftCard.findFirst.mockClear()
    await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).rejects.toMatchObject({ statusCode: 429 })
    expect(prismaMock.giftCard.findFirst).not.toHaveBeenCalled()
  })
})
