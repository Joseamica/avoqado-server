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

/** Ronda 1 de A8 (fix 4): el límite aguanta peticiones simultáneas y su 429 dice QUÉ límite se agotó. */
describe('lookupGiftCardsByCode — límite con peticiones simultáneas (r1)', () => {
  /** Una consulta a la base que no contesta hasta que la prueba la suelta: todas las peticiones quedan «en vuelo». */
  function baseEnEspera<T>(valor: T): () => void {
    let soltar!: () => void
    const respuesta = new Promise<T>(resolve => (soltar = () => resolve(valor)))
    prismaMock.giftCard.findFirst.mockReturnValue(respuesta as never)
    return soltar
  }
  const codigos = (r: PromiseSettledResult<unknown>[]) =>
    r.map(x => (x.status === 'rejected' ? (x.reason as { statusCode: number }).statusCode : 200)).sort()

  it('🔴 25 consultas A LA VEZ desde un aparato: sólo 20 llegan a la base; las otras 5 son 429', async () => {
    const soltar = baseEnEspera(null)
    const intentos = Array.from({ length: 25 }, () => lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' }))
    soltar()
    const r = await Promise.allSettled(intentos)

    expect(codigos(r)).toEqual([...Array(20).fill(404), ...Array(5).fill(429)])
    expect(prismaMock.giftCard.findFirst).toHaveBeenCalledTimes(20)
  })

  // Apartar el lugar ANTES de consultar significa que un aparato tiene a lo más 20 consultas en vuelo a la vez (cada una
  // aparta uno). Las que encuentran la tarjeta lo devuelven al terminar: no gastan el límite de fallos.
  it('las consultas simultáneas que SÍ encuentran la tarjeta devuelven su lugar: no gastan el límite de fallos', async () => {
    const soltar = baseEnEspera(sobre())
    const intentos = Array.from({ length: 20 }, () => lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' }))
    soltar()
    expect(codigos(await Promise.allSettled(intentos))).toEqual(Array(20).fill(200))

    prismaMock.giftCard.findFirst.mockReset().mockResolvedValue(null)
    for (let i = 0; i < 20; i++) {
      await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).rejects.toMatchObject({ statusCode: 404 })
    }
    await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).rejects.toMatchObject({ statusCode: 429 })
  })

  it('si la base falla, el lugar apartado se devuelve (no es un código inexistente)', async () => {
    prismaMock.giftCard.findFirst.mockRejectedValue(new Error('la base no contesta'))
    for (let i = 0; i < 25; i++) {
      await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).rejects.toThrow('la base no contesta')
    }
    prismaMock.giftCard.findFirst.mockReset().mockResolvedValue(null)
    await expect(lookupGiftCardsByCode(VENUE, codigo.normalized, { deviceId: 'dev-1' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it.each([
    ['el aparato', 20, (i: number) => ({ deviceId: 'dev-1', ip: `10.0.0.${i}` }), 'APARATO', 'desde este aparato'],
    ['la red (IP)', 40, (i: number) => ({ deviceId: `dev-${i}`, ip: '10.9.9.9' }), 'IP', 'desde esta red'],
    ['el negocio (sin aparato ni IP)', 60, () => ({}), 'NEGOCIO', 'en este negocio'],
  ])('el 429 nombra el límite que se agotó: %s', async (_caso, maximo, origen, limite, texto) => {
    for (let i = 0; i < maximo; i++) await lookupGiftCardsByCode(VENUE, codigo.normalized, origen(i)).catch(() => undefined)
    const error = await lookupGiftCardsByCode(VENUE, codigo.normalized, origen(maximo)).catch(e => e)
    expect(error).toMatchObject({ statusCode: 429, code: 'GIFT_CARD_LOOKUP_RATE_LIMITED', details: { retryAfter: 600, limite } })
    expect(error.message).toContain(texto)
  })
})
