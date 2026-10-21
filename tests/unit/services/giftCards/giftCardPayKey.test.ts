/**
 * Q91 y Q94 (tarjetas 1b, S2): la llave de un cobro con saldo. Un solo envío por llave a la vez (candado de la llave,
 * LO PRIMERO de la transacción) y un rechazo definitivo que no cambia en 10 min (el sello). Lo que se reintenta con la MISMA
 * llave es la tabla «Rechazos que se reintentan con la misma llave (Q94)» del contrato del índice: lo demás se sella.
 */
import AppError, { BadRequestError, ConflictError, ServiceUnavailableError } from '@/errors/AppError'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import {
  CODIGOS_REINTENTABLES,
  SELLO_DE_RECHAZO_MS,
  rechazoSellado,
  reiniciarSellosParaPruebas,
  sellarSiEsDefinitivo,
  tamanoDeSellosParaPruebas,
  tomarLlaveDeCobro,
} from '@/services/giftCards/giftCardPayKey'
import { CobroYaRegistrado } from '@/services/shared/cuentaCancelada'

const T0 = 1_760_000_000_000
const V = 'venue-1'
const K = 'llave-0001'

beforeEach(() => reiniciarSellosParaPruebas())

describe('el sello de un rechazo (Q91)', () => {
  it('sellar y leer devuelve el mismo error (mismo objeto: statusCode, code, message, details)', () => {
    const e = new GiftCardError('GIFT_CARD_INSUFFICIENT_BALANCE', 'Quedan $100.00 en la tarjeta de regalo.', 409, { saldoDisponible: 100 })
    sellarSiEsDefinitivo(V, K, e, T0)
    const sellado = rechazoSellado(V, K, T0 + 1) as AppError
    expect(sellado).toBe(e)
    expect(sellado).toMatchObject({
      statusCode: 409,
      code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
      message: 'Quedan $100.00 en la tarjeta de regalo.',
      details: { saldoDisponible: 100 },
    })
  })

  it('a los 10 min − 1 ms sigue; a los 10 min + 1 ms ya no hay sello', () => {
    const e = new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404)
    sellarSiEsDefinitivo(V, K, e, T0)
    expect(SELLO_DE_RECHAZO_MS).toBe(10 * 60_000)
    expect(rechazoSellado(V, K, T0 + SELLO_DE_RECHAZO_MS - 1)).toBe(e)
    expect(rechazoSellado(V, K, T0 + SELLO_DE_RECHAZO_MS + 1)).toBeNull()
  })

  it('otra llave u otro negocio no lo ve', () => {
    sellarSiEsDefinitivo(V, K, new GiftCardError('GIFT_CARD_BLOCKED', 'Bloqueada.', 409), T0)
    expect(rechazoSellado(V, 'llave-0002', T0 + 1)).toBeNull()
    expect(rechazoSellado('venue-2', K, T0 + 1)).toBeNull()
  })

  it('sellar dos veces no alarga el plazo (y conserva el primer rechazo)', () => {
    const primero = new GiftCardError('GIFT_CARD_EXPIRED', 'Esta tarjeta de regalo ya venció.', 409)
    sellarSiEsDefinitivo(V, K, primero, T0)
    sellarSiEsDefinitivo(V, K, new GiftCardError('GIFT_CARD_BLOCKED', 'Bloqueada.', 409), T0 + 5 * 60_000)
    expect(rechazoSellado(V, K, T0 + SELLO_DE_RECHAZO_MS - 1)).toBe(primero)
    expect(rechazoSellado(V, K, T0 + SELLO_DE_RECHAZO_MS + 1)).toBeNull()
  })

  it('sellar purga los vencidos (el tamaño del mapa baja)', () => {
    const e = () => new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta de regalo en este negocio.', 404)
    sellarSiEsDefinitivo(V, 'llave-a-0001', e(), T0)
    sellarSiEsDefinitivo(V, 'llave-b-0001', e(), T0)
    sellarSiEsDefinitivo(V, 'llave-c-0001', e(), T0)
    expect(tamanoDeSellosParaPruebas()).toBe(3)
    sellarSiEsDefinitivo(V, 'llave-d-0001', e(), T0 + SELLO_DE_RECHAZO_MS + 1)
    expect(tamanoDeSellosParaPruebas()).toBe(1)
  })
})

describe('Q94: qué se sella y qué se reintenta con la misma llave', () => {
  it('CODIGOS_REINTENTABLES es la tabla del contrato', () => {
    expect(new Set(CODIGOS_REINTENTABLES)).toEqual(new Set(['ORDER_PAYMENT_CONFLICT', 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE']))
    expect(CODIGOS_REINTENTABLES).toHaveLength(2)
  })

  it.each(CODIGOS_REINTENTABLES)('un reintentable de la tabla no se sella (%s)', code => {
    sellarSiEsDefinitivo(V, K, new ConflictError('Intenta otra vez.', code), T0)
    expect(rechazoSellado(V, K, T0 + 1)).toBeNull()
  })

  const NO_SE_SELLAN: Array<[string, unknown]> = [
    ['429 con code', new AppError('Demasiados intentos.', 429, true, 'GIFT_CARD_LOOKUP_RATE_LIMITED', { retryAfter: 60 })],
    ['500', new AppError('Error interno del servidor', 500, true, 'ALGO_INTERNO')],
    ['503 con code', new ServiceUnavailableError('No disponible.', 'DB_UNAVAILABLE')],
    ['sin code', new BadRequestError('Order is already paid')],
    ['CobroYaRegistrado', new CobroYaRegistrado('payment-1')],
    ['P2028', Object.assign(new Error('Transaction already closed'), { code: 'P2028' })],
    ['PAY_CASH_CAS_LOST', Object.assign(new Error('PAY_CASH_CAS_LOST'), { code: 'PAY_CASH_CAS_LOST' })],
  ]
  it.each(NO_SE_SELLAN)('no se sella (%s)', (_caso, err) => {
    sellarSiEsDefinitivo(V, K, err, T0)
    expect(rechazoSellado(V, K, T0 + 1)).toBeNull()
  })

  /** La tabla «Q94» de la parte S (S2), medida en origin/develop ad5b2c804, más uno inventado: lo que no está en la tabla se sella. */
  const DEFINITIVOS_MEDIDOS: Array<[string, number]> = [
    ['ORDER_CANCELLED_NO_NEW_CHARGE', 400],
    ['GIFT_CARD_TENDER_NOT_ALLOWED', 409],
    ['GIFT_CARD_AMOUNT_OUT_OF_RANGE', 422],
    ['GIFT_CARD_NOT_FOUND', 404],
    ['GIFT_CARD_BLOCKED', 409],
    ['GIFT_CARD_EXPIRED', 409],
    ['GIFT_CARD_INSUFFICIENT_BALANCE', 409],
    ['GIFT_CARDS_DISABLED', 409],
    ['TABLE_OWNED_BY_OTHER', 403],
    ['ORDER_PRICE_CHANGED', 409],
    ['GIFT_CARD_ORDER_IMMUTABLE', 409],
    ['IDEMPOTENCY_KEY_REUSED', 409],
    ['GIFT_CARD_STAMP_REWARD_NOT_APPLIED', 409],
    ['GIFT_CARD_PHONE_PROOF_INVALID', 409],
    ['CODIGO_NUEVO_X', 409],
  ]
  it.each(DEFINITIVOS_MEDIDOS)('un definitivo se sella (%s)', (code, status) => {
    const e = new AppError('rechazo definitivo', status, true, code)
    sellarSiEsDefinitivo(V, K, e, T0)
    expect(rechazoSellado(V, K, T0 + 1)).toBe(e)
  })
})

describe('tomarLlaveDeCobro (Q91)', () => {
  const RELOJ_DE_LA_BASE = 1_760_000_123_456
  function txFalso(pago: { id: string } | null) {
    const orden: string[] = []
    const tx = {
      $executeRaw: jest.fn(async (..._a: unknown[]) => {
        orden.push('candado')
        return 0
      }),
      payment: {
        findUnique: jest.fn(async () => {
          orden.push('payment')
          return pago
        }),
      },
      $queryRaw: jest.fn(async () => {
        orden.push('reloj')
        return [{ ms: BigInt(RELOJ_DE_LA_BASE) }]
      }),
    }
    return { tx, orden }
  }

  it('la PRIMERA llamada es el candado de la llave: pg_advisory_xact_lock(hashtext(giftpay:<negocio>:<llave>))', async () => {
    const { tx, orden } = txFalso(null)
    await tomarLlaveDeCobro(tx as any, V, K)
    expect(orden[0]).toBe('candado')
    const [plantilla, ...valores] = tx.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    expect(plantilla.join('?')).toMatch(/SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)/)
    expect(valores).toEqual([`giftpay:${V}:${K}`])
    expect(tx.payment.findUnique).toHaveBeenCalledWith({
      where: { venueId_idempotencyKey: { venueId: V, idempotencyKey: K } },
      select: { id: true },
    })
  })

  it('con un Payment de la llave ⇒ cobroPrevioId, y no mira el sello', async () => {
    sellarSiEsDefinitivo(V, K, new GiftCardError('GIFT_CARD_NOT_FOUND', 'No encontramos esa tarjeta.', 404))
    const { tx } = txFalso({ id: 'payment-9' })
    await expect(tomarLlaveDeCobro(tx as any, V, K)).resolves.toMatchObject({ cobroPrevioId: 'payment-9' })
  })

  it('sin Payment y con la llave sellada ⇒ lanza el error sellado', async () => {
    const e = new GiftCardError('GIFT_CARD_INSUFFICIENT_BALANCE', 'Quedan $100.00 en la tarjeta de regalo.', 409)
    sellarSiEsDefinitivo(V, K, e)
    const { tx } = txFalso(null)
    await expect(tomarLlaveDeCobro(tx as any, V, K)).rejects.toBe(e)
  })

  it('si no ⇒ cobroPrevioId null y `ahora` = el epoch de clock_timestamp() leído YA con el candado', async () => {
    const { tx, orden } = txFalso(null)
    const r = await tomarLlaveDeCobro(tx as any, V, K)
    expect(r).toEqual({ cobroPrevioId: null, ahora: new Date(RELOJ_DE_LA_BASE) })
    expect(orden).toEqual(['candado', 'payment', 'reloj'])
    const sql = (tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?')
    expect(sql).toContain('clock_timestamp()')
    expect(sql).not.toMatch(/now\(\)/i)
  })
})
