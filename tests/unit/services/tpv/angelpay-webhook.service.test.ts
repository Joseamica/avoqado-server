import {
  validateAngelPayWebhookPayload,
  persistErrorEvent,
  attemptPaymentMatch,
  processAngelPayWebhook,
  reconcileAngelPayWebhookForPayment,
} from '@/services/tpv/angelpay-webhook.service'
import prisma from '@/utils/prismaClient'
import { Prisma } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => {
  const db: Record<string, unknown> = {
    // Codex R2 (P2): el backfill reclama el evento y estampa el Payment en UNA transacción; el mock ejecuta el
    // callback sobre el mismo objeto para que las aserciones sigan midiendo las mismas escrituras.
    $transaction: (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : Promise.all(fn as unknown[])),
    // S1 (13-sep): el webhook consulta el vínculo intento → solicitud; sin vínculo (null) sigue el flujo de siempre.
    terminalPaymentAttemptLink: { findUnique: jest.fn().mockResolvedValue(null) },
    // Codex R4-5: el matcher DÉBIL toma el candado del evento (`FOR UPDATE`) antes de sellar y vuelve a mirar el vínculo.
    $queryRaw: jest.fn().mockResolvedValue([]),
    terminalPaymentRequest: { findFirst: jest.fn().mockResolvedValue(null) },
    providerEventLog: (() => {
      // S4 (13-sep): las escrituras finales del receptor van por `updateMany` con el `where` guardado por el token del
      // worker (vacío en el receptor). `updateMany` ES el mismo `jest.fn` que `update` para que las aserciones sigan
      // midiendo LA MISMA escritura (where + data) — sin aflojar ninguna. (Sin getter: dentro de la fábrica de `jest.mock`
      // `this` se tipa como `{}` y el typecheck del CI lo rechaza.)
      const update = jest.fn()
      return { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update, updateMany: update }
    })(),
    payment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    merchantAccount: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    activityLog: {
      create: jest.fn(),
    },
    // Codex R1 (P2): toda huella sobre `Payment.processorData` va en SQL sobre el valor VIGENTE (`||` de jsonb).
    $executeRaw: jest.fn(),
    // Codex R6-2: el candado por intento (`SET LOCAL lock_timeout` + `pg_advisory_xact_lock`) precede al candado del evento.
    $executeRawUnsafe: jest.fn(),
  }
  return { __esModule: true, default: db }
})

const mockedProviderEventLogCreate = prisma.providerEventLog.create as jest.Mock
const mockedProviderEventLogFindFirst = prisma.providerEventLog.findFirst as jest.Mock
const mockedProviderEventLogFindMany = prisma.providerEventLog.findMany as jest.Mock
const mockedProviderEventLogUpdate = prisma.providerEventLog.update as jest.Mock
const mockedPaymentFindFirst = prisma.payment.findFirst as jest.Mock
const mockedPaymentFindUnique = prisma.payment.findUnique as jest.Mock
const mockedPaymentUpdate = prisma.payment.update as jest.Mock
const mockedMerchantAccountUpdate = prisma.merchantAccount.update as jest.Mock
const mockedMerchantAccountFindUnique = prisma.merchantAccount.findUnique as jest.Mock
const mockedActivityLogCreate = prisma.activityLog.create as jest.Mock
const mockedExecuteRaw = prisma.$executeRaw as unknown as jest.Mock

/**
 * Codex R1 (P2): la huella del webhook se fusiona en SQL sobre el valor VIGENTE del JSON (`"processorData" || parche`),
 * nunca desde una copia leída antes. El mock del tagged template recibe (strings, jsonDelParche, paymentId).
 */
const estampas = () =>
  mockedExecuteRaw.mock.calls.map(([strings, json, paymentId]) => ({
    sql: (strings as TemplateStringsArray).join('?'),
    paymentId: paymentId as string,
    parche: JSON.parse(json as string) as Record<string, any>,
  }))
const estampa = (paymentId: string): Record<string, any> => {
  const propias = estampas().filter(e => e.paymentId === paymentId)
  expect(propias).toHaveLength(1)
  // Fusión sobre el valor vigente: el SQL concatena el JSON existente con el parche, no lo sustituye.
  expect(propias[0].sql).toContain(`"processorData" ELSE '{}'::jsonb END || CAST(`)
  return propias[0].parche
}

beforeEach(() => {
  mockedExecuteRaw.mockReset()
  mockedExecuteRaw.mockResolvedValue(1)
})

// Shared test merchantAccount arg
const TEST_MERCHANT = { id: 'ma_1', externalMerchantId: '351' }

describe('validateAngelPayWebhookPayload', () => {
  // Real production body shape — no id_merchant at top level
  const valid = {
    event_type: 'send_transaction',
    payload: { amount: '000000000100' },
  }

  it('accepts a minimal valid payload', () => {
    expect(validateAngelPayWebhookPayload(valid)).toBe(true)
  })

  it('rejects when event_type is missing', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, event_type: undefined })).toBe(false)
  })

  it('rejects when payload.amount is missing', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, payload: {} })).toBe(false)
  })

  it('rejects null/non-object inputs', () => {
    expect(validateAngelPayWebhookPayload(null)).toBe(false)
    expect(validateAngelPayWebhookPayload(undefined)).toBe(false)
    expect(validateAngelPayWebhookPayload('string')).toBe(false)
  })
})

describe('persistErrorEvent', () => {
  beforeEach(() => {
    mockedProviderEventLogCreate.mockReset()
  })

  it('creates a ProviderEventLog row with status=ERROR and the given errorReason', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_123' })
    const result = await persistErrorEvent({
      eventId: 'angelpay-msg_1',
      type: 'send_transaction',
      payload: { event_type: 'send_transaction', payload: { amount: '100' } } as any,
      venueId: null,
      errorReason: 'UNKNOWN_MERCHANT',
    })
    expect(result.id).toBe('evt_123')
    expect(mockedProviderEventLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'PAYMENT_PROCESSOR',
        eventId: 'angelpay-msg_1',
        status: 'ERROR',
        errorReason: 'UNKNOWN_MERCHANT',
        type: 'send_transaction',
        venueId: null,
      }),
      select: { id: true },
    })
  })
})

describe('attemptPaymentMatch', () => {
  beforeEach(() => {
    mockedPaymentFindFirst.mockReset()
  })

  const baseArgs = {
    payload: {
      event_type: 'send_transaction',
      payload: {
        integratorReference: 'ref-123',
        transactionId: 'tx_abc',
        amount: '000000010000', // 10000 cents = $100.00
      },
    } as any,
    merchantAccountId: 'ma_xyz',
    retryDelaysMs: [0, 0, 0],
  }

  it('returns the payment on first attempt when found', async () => {
    const payment = { id: 'pay_1', amount: 100, venueId: 'venue_1' }
    mockedPaymentFindFirst.mockResolvedValueOnce(payment)
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toBe(payment)
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(1)
  })

  it('retries up to 3 times and returns the payment when later attempts succeed', async () => {
    mockedPaymentFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'pay_2', amount: 100, venueId: 'venue_1' })
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toEqual({ id: 'pay_2', amount: 100, venueId: 'venue_1' })
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(3)
  })

  it('returns null after 3 attempts with no match', async () => {
    mockedPaymentFindFirst.mockResolvedValue(null)
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toBeNull()
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(3)
  })

  it('builds OR conditions from integratorReference, transactionId and scopes by merchantAccountId — the weak keys never contradict a strong one (Codex R1 P1-1)', async () => {
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_3', venueId: 'venue_1' })
    await attemptPaymentMatch(baseArgs)
    // `transactionId`/`referenceNumber` son `yyMMddHHmmss`: dos cobros del mismo segundo colisionan. Con llave FUERTE en el
    // webhook, una coincidencia débil sólo vale sobre un Payment SIN llave o con la MISMA — nunca sobre el de OTRO intento.
    const soloSinLlaveOLaMisma = { OR: [{ idempotencyKey: null }, { idempotencyKey: 'ref-123' }] }
    expect(mockedPaymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { idempotencyKey: 'ref-123' },
            { referenceNumber: 'ref-123' },
            { AND: [{ processorId: 'tx_abc' }, soloSinLlaveOLaMisma] },
            // 2026-07-29: the TPV stores AngelPay's transactionId as referenceNumber —
            // without this key, webhooks lacking integratorReference never match directly.
            { AND: [{ referenceNumber: 'tx_abc' }, soloSinLlaveOLaMisma] },
          ],
          status: { in: ['COMPLETED', 'PENDING'] },
          merchantAccountId: 'ma_xyz',
        }),
      }),
    )
  })

  it('sin integratorReference (webhook legacy) las llaves débiles van solas: no hay llave fuerte que contradecir', async () => {
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_3b', venueId: 'venue_1' })
    await attemptPaymentMatch({
      ...baseArgs,
      payload: { ...baseArgs.payload, payload: { ...baseArgs.payload.payload, integratorReference: undefined } } as any,
    })
    expect(mockedPaymentFindFirst.mock.calls[0][0].where.OR).toEqual([{ processorId: 'tx_abc' }, { referenceNumber: 'tx_abc' }])
  })

  it('omits a condition when its corresponding field is missing', async () => {
    mockedPaymentFindFirst.mockResolvedValueOnce(null)
    await attemptPaymentMatch({
      ...baseArgs,
      payload: { ...baseArgs.payload, payload: { ...baseArgs.payload.payload, transactionId: undefined } } as any,
    })
    const callArgs = mockedPaymentFindFirst.mock.calls[0][0]
    expect(callArgs.where.OR).toEqual([{ idempotencyKey: 'ref-123' }, { referenceNumber: 'ref-123' }])
  })
})

describe('processAngelPayWebhook — MATCHED happy path', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
    // Codex R5-4: la escritura final es un CAS ({count}); la huella sólo se estampa si el reclamo aplicó (count === 1).
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 1 })
  })

  it('stamps processorData.angelpayWebhook, marks event PROCESSED, touches lastReceivedAt', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_1' })
    // Payment amount: $100.00 pesos. Webhook amount: 10000 cents = $100.00 pesos → diff < 0.01 → MATCHED
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_1', amount: 100, processorData: null, venueId: 'venue_1' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: {
          integratorReference: 'ref-1',
          amount: '000000010000', // 10000 cents = $100.00 MXN
          status: 'approved',
          transactionId: 'tx_1',
          terminalSerial: '12345678',
          timestamp: '2026-03-20T12:34:56Z',
        },
      } as any,
      eventId: 'msg_a',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('MATCHED')
    expect(result.paymentId).toBe('pay_1')
    expect(result.eventLogId).toBe('evt_1')

    expect(estampa('pay_1').angelpayWebhook).toEqual(
      expect.objectContaining({
        eventId: 'msg_a',
        transactionId: 'tx_1',
        integratorReference: 'ref-1',
        terminalSerial: '12345678',
        timestamp: '2026-03-20T12:34:56Z',
        status: 'approved',
      }),
    )
    // Nunca un `update` con el JSON completo: pisaría lo que S3 o el registrador escribieron en medio.
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_1', claimToken: expect.any(String) },
      data: expect.objectContaining({ status: 'PROCESSED', paymentId: 'pay_1', venueId: 'venue_1' }),
    })

    expect(mockedMerchantAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'ma_1' },
      data: { angelpayWebhookLastReceivedAt: expect.any(Date) },
    })
  })

  it('Codex R4-5: el sello DÉBIL sólo se escribe bajo el candado del evento y tras comprobar que el intento sigue SIN vínculo', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_lock' })
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_1', amount: 100, processorData: null, venueId: 'venue_1' })
    const queryRaw = (prisma as any).$queryRaw as jest.Mock
    queryRaw.mockClear()

    await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-1', amount: '000000010000', status: 'approved', transactionId: 'tx_1' },
      } as any,
      eventId: 'msg_lock',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    // Codex R15-1: el candado del EVENTO del escritor débil se reconoce por SU marcador (`/* evento */`), no por cualquier
    // `FOR UPDATE` sobre la tabla — el INGRESO también bloquea filas de `ProviderEventLog` (la recuperación de los ingresos sin
    // candado) y un `FOR UPDATE` cualquiera dejaría pasar a un escritor débil que no toma el suyo.
    const candado = queryRaw.mock.calls.find(([sql]) => Array.isArray(sql) && sql.join('?').includes('/* evento */'))
    expect(candado).toBeDefined()
    expect((candado![0] as string[]).join('?')).toContain('"ProviderEventLog"')
    expect((candado![0] as string[]).join('?')).toContain('FOR UPDATE')
    // El vínculo se vuelve a consultar DESPUÉS del candado (una vez antes, una vez bajo el candado).
    expect((prisma as any).terminalPaymentAttemptLink.findUnique).toHaveBeenCalledTimes(2)
    // Codex R6-2: la EXCLUSIÓN por intento (advisory de dos llaves con la llave normalizada) va ANTES del candado del evento,
    // con la espera acotada en su propia sentencia. (El ingreso también toma el advisory antes: se compara con el ÚLTIMO advisory,
    // el del escritor débil, que precede inmediatamente a su candado del evento.)
    const evento = queryRaw.mock.calls.findIndex(([sql]) => Array.isArray(sql) && sql.join('?').includes('/* evento */'))
    const advisory = queryRaw.mock.calls
      .map(([sql], i) => (Array.isArray(sql) && sql.join('?').includes('pg_advisory_xact_lock') && i < evento ? i : -1))
      .filter(i => i >= 0)
      .pop()!
    expect(advisory).toBeGreaterThanOrEqual(0)
    expect(advisory).toBeLessThan(evento)
    expect(queryRaw.mock.calls[advisory].slice(1)).toEqual([7_310_113, 'ref-1'])
    const espera = ((prisma as any).$executeRawUnsafe as jest.Mock).mock.calls.map(([sql]) => sql as string)
    expect(espera.some(sql => /SET LOCAL lock_timeout = '\d+ms'/.test(sql))).toBe(true)
  })

  it('Codex R4-5: si BAJO el candado el intento ya tiene vínculo, NO se sella sobre el Payment débil: se confirma por el vínculo', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_race' })
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_debil', amount: 100, processorData: null, venueId: 'venue_1' })
    const findUnique = (prisma as any).terminalPaymentAttemptLink.findUnique as jest.Mock
    findUnique
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ requestId: 'req-1', venueId: 'venue_1', terminalId: 't1', createdAt: new Date() })
    ;(prisma as any).$executeRaw.mockClear()

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-1', amount: '000000010000', status: 'approved', transactionId: 'tx_1' },
      } as any,
      eventId: 'msg_race',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    // Sin fila de solicitud en este arnés la confirmación por vínculo no puede crear dinero: el evento queda PENDING/AWAITING_PAYMENT.
    expect(result.action).not.toBe('MATCHED')
    expect(estampas().filter(e => e.paymentId === 'pay_debil')).toHaveLength(0)
    expect(mockedProviderEventLogUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSED', paymentId: 'pay_debil' }) }),
    )
    findUnique.mockReset().mockResolvedValue(null)
  })

  it('treats tip as part of the charged amount: base + tip == webhook → MATCHED (regression)', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_tip' })
    // Card charged base($100) + tip($10) = $110. Webhook = 11000 cents = $110.00.
    // Comparing against base alone ($100) would WRONGLY flag a $10 discrepancy.
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_tip', amount: 100, tipAmount: 10, processorData: null, venueId: 'venue_1' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: {
          integratorReference: 'ref-tip',
          amount: '000000011000', // 11000 cents = $110.00 = base + tip
          status: 'approved',
          transactionId: 'tx_tip',
        },
      } as any,
      eventId: 'msg_tip',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('MATCHED')
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_tip', claimToken: expect.any(String) },
      data: expect.objectContaining({ status: 'PROCESSED', paymentId: 'pay_tip' }),
    })
  })
})

describe('processAngelPayWebhook — DISCREPANCY', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 1 })
  })

  it('stamps angelpayDiscrepancy, marks event ERROR/AMOUNT_MISMATCH, does NOT mutate payment.status', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_2' })
    // Payment amount: $100.00. Webhook: "000001055000" = 1055000 cents? No — use "000000010550" = 10550 cents = $105.50 → diff = 5.50 → DISCREPANCY
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_2', amount: 100, processorData: { existing: true }, venueId: 'venue_1' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: {
          integratorReference: 'ref-2',
          amount: '000000010550', // 10550 cents = $105.50 MXN → diff vs $100.00 = 5.50
          status: 'approved',
          transactionId: 'tx_2',
        },
      } as any,
      eventId: 'msg_b',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('DISCREPANCY')
    expect(result.errorReason).toBe('AMOUNT_MISMATCH')

    const parche = estampa('pay_2')
    expect(parche.angelpayDiscrepancy).toEqual(
      expect.objectContaining({ webhookAmount: 105.5, recordedAmount: 100, difference: 5.5, transactionId: 'tx_2' }),
    )
    // Sólo se AÑADE la discrepancia: lo existente lo conserva la fusión SQL, y el status del Payment no se toca.
    expect(Object.keys(parche)).toEqual(['angelpayDiscrepancy'])
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_2', claimToken: expect.any(String) },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'AMOUNT_MISMATCH', paymentId: 'pay_2' }),
    })
  })
})

describe('processAngelPayWebhook — early-return paths', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('returns NOT_APPROVED when payload.status is not approved', async () => {
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_3' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-3', amount: '000000005000', status: 'declined' },
      } as any,
      eventId: 'msg_c',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('NOT_APPROVED')
    expect(mockedPaymentFindFirst).not.toHaveBeenCalled()
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_3', claimToken: expect.any(String) },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'NOT_APPROVED' }),
    })
  })

  it('returns UNSUPPORTED_EVENT_TYPE for event_type != send_transaction', async () => {
    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'canceled_transaction',
        payload: { amount: '000000001000' },
      } as any,
      eventId: 'msg_d',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('UNSUPPORTED_EVENT_TYPE')
    expect(mockedPaymentFindFirst).not.toHaveBeenCalled()
  })
})

describe('processAngelPayWebhook — error paths', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('returns DUPLICATE when ProviderEventLog already has this event-id (P2002 race)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique violation', { code: 'P2002', clientVersion: 'x' })
    mockedProviderEventLogCreate.mockRejectedValueOnce(p2002)
    mockedProviderEventLogFindFirst.mockResolvedValue({ id: 'evt_existing', paymentId: 'pay_existing' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-dup', amount: '000000001000', status: 'approved' },
      } as any,
      eventId: 'msg_f',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('DUPLICATE')
    expect(result.eventLogId).toBe('evt_existing')
    expect(result.paymentId).toBe('pay_existing')
  })

  it('returns ORPHANED/AWAITING_PAYMENT and leaves event PENDING when no Payment matches after retries', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_5' })
    mockedPaymentFindFirst.mockResolvedValue(null)

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-miss', amount: '000000001000', status: 'approved' },
      } as any,
      eventId: 'msg_g',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    // action stays ORPHANED (HTTP cosmetic); status row is PENDING so backfill can reconcile
    expect(result.action).toBe('ORPHANED')
    expect(result.errorReason).toBe('AWAITING_PAYMENT')
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_5', claimToken: expect.any(String) },
      data: expect.objectContaining({ status: 'PENDING', errorReason: 'AWAITING_PAYMENT' }),
    })
    // Must NOT set processedAt (event is not yet terminal)
    const updateArgs = mockedProviderEventLogUpdate.mock.calls[0][0]
    expect(updateArgs.data).not.toHaveProperty('processedAt')
  })

  it('Codex R3 (P2): si el receptor PERDIÓ la propiedad antes de su escritura final (el CAS no aplica), contesta el desenlace DURABLE que otro dueño dejó — no ORPHANED', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_7' })
    mockedPaymentFindFirst.mockResolvedValue(null)
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 0 })
    mockedProviderEventLogFindFirst.mockResolvedValue({ status: 'PROCESSED', paymentId: 'pay_del_rest', errorReason: null })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-late', amount: '000000001000', status: 'approved' },
      } as any,
      eventId: 'msg_late',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result).toMatchObject({
      action: 'MATCHED',
      paymentId: 'pay_del_rest',
      eventLogId: 'evt_7',
      message: 'RESOLVED_BY_ANOTHER_OWNER',
    })
    expect(mockedProviderEventLogFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'evt_7' } }))
  })

  it('Codex R3 (P2): con la escritura final APLICADA (una fila) sigue contestando ORPHANED/AWAITING_PAYMENT sin releer nada', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_8' })
    mockedPaymentFindFirst.mockResolvedValue(null)
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 1 })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-own', amount: '000000001000', status: 'approved' },
      } as any,
      eventId: 'msg_own',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result).toMatchObject({ action: 'ORPHANED', errorReason: 'AWAITING_PAYMENT' })
    expect(mockedProviderEventLogFindFirst).not.toHaveBeenCalled()
  })

  it('returns ORPHANED/NO_MATCH_FIELDS when payload has none of integratorReference/transactionId', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_6' })
    mockedPaymentFindFirst.mockResolvedValue(null)

    const result = await processAngelPayWebhook({
      payload: { event_type: 'send_transaction', payload: { amount: '000000001000', status: 'approved' } } as any,
      eventId: 'msg_h',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('ORPHANED')
    expect(result.errorReason).toBe('NO_MATCH_FIELDS')
    // NO_MATCH_FIELDS is genuinely unprocessable — must stay terminal ERROR (not PENDING)
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_6', claimToken: expect.any(String) },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'NO_MATCH_FIELDS' }),
    })
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reconcileAngelPayWebhookForPayment — backfill tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('reconcileAngelPayWebhookForPayment', () => {
  const basePayment = {
    id: 'pay_backfill_1',
    idempotencyKey: 'idem-abc',
    referenceNumber: null,
    venueId: 'venue_x',
    amount: 100,
    tipAmount: 0,
  }

  const pendingEvent = {
    id: 'evt_pending_1',
    payload: {
      event_type: 'send_transaction',
      payload: {
        amount: '000000010000', // 10000 cents = $100.00 MXN — exact match
        integratorReference: 'idem-abc',
        transactionId: 'tx_ap_1',
        terminalSerial: 'N860W175781',
        timestamp: '2026-05-28T01:00:00Z',
        status: 'approved',
      },
    },
  }

  beforeEach(() => {
    ;[mockedProviderEventLogFindMany, mockedProviderEventLogUpdate, mockedPaymentFindUnique, mockedPaymentUpdate].forEach(m =>
      m.mockReset(),
    )
    // Codex R1 (P2): el backfill RECLAMA el evento con CAS (`updateMany` ⇒ {count}) ANTES de estampar el Payment.
    mockedPaymentFindUnique.mockResolvedValue({ processorData: null })
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 1 })
    mockedPaymentUpdate.mockResolvedValue({})
  })

  it('stamps processorData.angelpayWebhook and marks event PROCESSED on amount match', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([pendingEvent])

    await reconcileAngelPayWebhookForPayment(basePayment)

    expect(estampa('pay_backfill_1').angelpayWebhook).toEqual(
      expect.objectContaining({
        reconciledVia: 'payment-create-backfill',
        transactionId: 'tx_ap_1',
        integratorReference: 'idem-abc',
        terminalSerial: 'N860W175781',
        status: 'approved',
      }),
    )

    // El reclamo del evento es un CAS: sigue PENDING y sin lease vigente (si el worker lo tomó en medio, no se estampa).
    // Codex R2 (P2-1): y estrena token de dueño — una escritura TARDÍA del receptor (con su token viejo) ya no aplica.
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'evt_pending_1',
          status: 'PENDING',
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: expect.any(Date) } }],
        }),
        data: expect.objectContaining({
          claimToken: expect.any(String),
          status: 'PROCESSED',
          paymentId: 'pay_backfill_1',
          venueId: 'venue_x',
          errorReason: null,
        }),
      }),
    )
  })

  it('treats tip as part of the charged amount on backfill: base + tip == webhook → MATCHED (regression)', async () => {
    // Card charged base($100) + tip($10) = $110. Pending webhook = 11000 cents = $110.00.
    const tippedEvent = {
      id: 'evt_pending_tip',
      payload: {
        event_type: 'send_transaction',
        payload: {
          amount: '000000011000', // 11000 cents = $110.00 = base + tip
          integratorReference: 'idem-abc',
          transactionId: 'tx_ap_tip',
          status: 'approved',
        },
      },
    }
    mockedProviderEventLogFindMany.mockResolvedValue([tippedEvent])

    await reconcileAngelPayWebhookForPayment({ ...basePayment, amount: 100, tipAmount: 10 })

    // MATCHED → stamps angelpayWebhook (not angelpayDiscrepancy), event PROCESSED.
    const parche = estampa('pay_backfill_1')
    expect(parche).toHaveProperty('angelpayWebhook')
    expect(parche).not.toHaveProperty('angelpayDiscrepancy')
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'evt_pending_tip', status: 'PENDING' }),
        data: expect.objectContaining({ status: 'PROCESSED', errorReason: null }),
      }),
    )
  })

  it('preserves existing processorData keys when stamping angelpayWebhook: fusión SQL sobre el valor VIGENTE, sin releer ni reescribir el JSON (Codex R1 P2)', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([pendingEvent])

    await reconcileAngelPayWebhookForPayment(basePayment)

    // Antes se leía el JSON, se hacía spread en memoria y se escribía entero: una lectura vieja pisaba lo que S3 o el
    // registrador dejaron en medio. Ahora el parche sólo trae la huella y Postgres conserva el resto (`||`).
    const parche = estampa('pay_backfill_1')
    expect(Object.keys(parche)).toEqual(['angelpayWebhook'])
    expect(parche.angelpayWebhook).toEqual(expect.objectContaining({ reconciledVia: 'payment-create-backfill' }))
    expect(mockedPaymentFindUnique).not.toHaveBeenCalled()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })

  it('si el worker reclamó el evento en medio (el CAS no aplica), el backfill NO estampa el Payment ni lo da por suyo', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([pendingEvent])
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 0 })

    await reconcileAngelPayWebhookForPayment(basePayment)

    expect(mockedExecuteRaw).not.toHaveBeenCalled()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })

  it('Codex R1 P1-1: un evento con la llave de OTRO intento no es de este Payment aunque la referencia y el importe coincidan', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([
      {
        id: 'evt_de_otro',
        payload: {
          event_type: 'send_transaction',
          payload: { amount: '000000010000', integratorReference: 'idem-de-otro-intento', transactionId: 'tx_ap_1', status: 'approved' },
        },
      },
    ])

    await reconcileAngelPayWebhookForPayment({ ...basePayment, referenceNumber: 'tx_ap_1' })

    expect(mockedExecuteRaw).not.toHaveBeenCalled()
    expect(mockedProviderEventLogUpdate).not.toHaveBeenCalled()
  })

  it('stamps angelpayDiscrepancy and marks ERROR/AMOUNT_MISMATCH on amount mismatch', async () => {
    const mismatchEvent = {
      id: 'evt_pending_mismatch',
      payload: {
        event_type: 'send_transaction',
        payload: {
          amount: '000000010550', // 10550 cents = $105.50 — diff $5.50 vs $100.00
          integratorReference: 'idem-abc',
          transactionId: 'tx_ap_mismatch',
          status: 'approved',
        },
      },
    }
    mockedProviderEventLogFindMany.mockResolvedValue([mismatchEvent])

    await reconcileAngelPayWebhookForPayment(basePayment)

    expect(estampa('pay_backfill_1').angelpayDiscrepancy).toEqual(
      expect.objectContaining({ webhookAmount: 105.5, recordedAmount: 100, transactionId: 'tx_ap_mismatch' }),
    )

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'ERROR',
          errorReason: 'AMOUNT_MISMATCH',
          paymentId: 'pay_backfill_1',
        }),
      }),
    )
  })

  it('is a no-op when no pending event is found', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([])

    await reconcileAngelPayWebhookForPayment(basePayment)

    expect(mockedExecuteRaw).not.toHaveBeenCalled()
    expect(mockedProviderEventLogUpdate).not.toHaveBeenCalled()
  })

  it('is a no-op and returns without querying when both idempotencyKey and referenceNumber are null', async () => {
    await reconcileAngelPayWebhookForPayment({
      ...basePayment,
      idempotencyKey: null,
      referenceNumber: null,
    })

    expect(mockedProviderEventLogFindMany).not.toHaveBeenCalled()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })

  it('never throws when findMany rejects — swallows error gracefully', async () => {
    mockedProviderEventLogFindMany.mockRejectedValue(new Error('DB connection lost'))

    // Must resolve without throwing
    await expect(reconcileAngelPayWebhookForPayment(basePayment)).resolves.toBeUndefined()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NUEVO (2026-07-29): detección de mismatch de comercio — incidente cross-merchant.
// El endpoint receptor (URL + secreto HMAC por comercio) prueba qué afiliación
// cobró; si difiere del comercio registrado en el Payment, se concilia PERO se
// marca ruidosamente en vez de absorberse en silencio por el backfill.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('processAngelPayWebhook — MATCHED_WRONG_MERCHANT (mismatch de comercio)', () => {
  const webhookBody = {
    event_type: 'send_transaction',
    payload: {
      amount: '000000006000', // $60.00 — caso real del incidente 2026-07-27
      integratorReference: 'idem-cross-1',
      transactionId: '260727125955',
      status: 'approved',
    },
  }

  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
      mockedMerchantAccountFindUnique,
      mockedActivityLogCreate,
    ].forEach(m => m.mockReset())
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_cross_1' })
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 1 })
    mockedPaymentUpdate.mockResolvedValue({})
    mockedMerchantAccountUpdate.mockResolvedValue({})
    mockedActivityLogCreate.mockResolvedValue({})
    // El receptor (ma_1) pertenece al venue_1 vía su login AngelPay
    mockedMerchantAccountFindUnique.mockResolvedValue({ angelpayUserAccount: { venueId: 'venue_1' } })
  })

  it('cuando el match filtrado falla pero un comercio hermano del MISMO venue tiene el pago: MATCHED_WRONG_MERCHANT + flag ruidoso', async () => {
    mockedPaymentFindFirst
      // 1er findFirst: match filtrado por el comercio receptor → nada
      .mockResolvedValueOnce(null)
      // 2o findFirst: cross-merchant → el pago registrado bajo el comercio hermano
      .mockResolvedValueOnce({
        id: 'pay_cross_1',
        amount: 60,
        tipAmount: 0,
        processorData: null,
        venueId: 'venue_1',
        merchantAccountId: 'ma_other',
      })

    const result = await processAngelPayWebhook({
      payload: webhookBody,
      eventId: 'msg_cross_1',
      merchantAccount: TEST_MERCHANT as any,
      retryDelaysMs: [0],
    })

    expect(result.action).toBe('MATCHED_WRONG_MERCHANT')
    expect(result.errorReason).toBe('MERCHANT_MISMATCH')
    expect(result.paymentId).toBe('pay_cross_1')

    // El query cruzado va acotado: mismo venue, otro comercio, solo ANGELPAY
    const crossCall = mockedPaymentFindFirst.mock.calls[1][0]
    expect(crossCall.where.venueId).toBe('venue_1')
    expect(crossCall.where.merchantAccountId).toEqual({ not: 'ma_1' })
    expect(crossCall.where.merchantAccount).toEqual({ provider: { code: 'ANGELPAY' } })
    // Codex R5-6: `type` es nullable (legacy); `not: 'REFUND'` a secas excluía esas filas de la conciliación.
    expect(crossCall.where.AND).toEqual(expect.arrayContaining([{ OR: [{ type: null }, { type: { not: 'REFUND' } }] }]))
    expect(crossCall.where).not.toHaveProperty('type')

    // El Payment queda estampado con el mismatch (quién recibió vs quién registró)
    expect(estampa('pay_cross_1').angelpayWebhook).toEqual(
      expect.objectContaining({ merchantMismatch: true, receivedByMerchantAccountId: 'ma_1', recordedMerchantAccountId: 'ma_other' }),
    )

    // El evento queda PROCESSED pero con errorReason MERCHANT_MISMATCH (visible en scans)
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_cross_1', claimToken: expect.any(String) },
        data: expect.objectContaining({
          status: 'PROCESSED',
          errorReason: 'MERCHANT_MISMATCH',
          paymentId: 'pay_cross_1',
        }),
      }),
    )

    // Audit trail para el owner (leíble vía get_activity_log)
    expect(mockedActivityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'ANGELPAY_MERCHANT_MISMATCH',
          entity: 'Payment',
          entityId: 'pay_cross_1',
          venueId: 'venue_1',
        }),
      }),
    )
  })

  it('el cruce exige monto al centavo: si difiere, NO se vincula y el evento queda PENDING (regresión anti-colisión)', async () => {
    mockedPaymentFindFirst
      .mockResolvedValueOnce(null) // filtrado
      .mockResolvedValueOnce({
        // cruzado: mismas llaves pero OTRO monto → colisión de referencia, no vincular
        id: 'pay_colision',
        amount: 999,
        tipAmount: 0,
        processorData: null,
        venueId: 'venue_1',
        merchantAccountId: 'ma_other',
      })

    const result = await processAngelPayWebhook({
      payload: webhookBody,
      eventId: 'msg_cross_2',
      merchantAccount: TEST_MERCHANT as any,
      retryDelaysMs: [0],
    })

    expect(result.action).toBe('ORPHANED')
    expect(result.errorReason).toBe('AWAITING_PAYMENT')
    expect(mockedExecuteRaw).not.toHaveBeenCalled()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    expect(mockedActivityLogCreate).not.toHaveBeenCalled()
  })

  it('sin venue resoluble del receptor NO hay cruce (nunca cross-tenant): queda PENDING', async () => {
    mockedMerchantAccountFindUnique.mockResolvedValue(null)
    mockedPaymentFindFirst.mockResolvedValueOnce(null)

    const result = await processAngelPayWebhook({
      payload: webhookBody,
      eventId: 'msg_cross_3',
      merchantAccount: TEST_MERCHANT as any,
      retryDelaysMs: [0],
    })

    expect(result.action).toBe('ORPHANED')
    // Solo 1 llamada: el match filtrado. El cruce ni se intentó.
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(1)
  })

  it('el insert PENDING estampa venueId del receptor, _avoqado.receivedByMerchantAccountId y (Codex R12-1) la captura de tarifa AL INGRESO', async () => {
    mockedPaymentFindFirst.mockResolvedValue(null)

    await processAngelPayWebhook({
      payload: webhookBody,
      eventId: 'msg_cross_4',
      merchantAccount: TEST_MERCHANT as any,
      retryDelaysMs: [0],
    })

    expect(mockedProviderEventLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          venueId: 'venue_1',
          payload: expect.objectContaining({
            // Codex R12-1: la tarifa se captura al INGRESO y viaja en el evento durable (aquí, sin base, con marcadores de
            // captura fallida — nunca ausente): S4 registra con ESA captura, no con la tarifa del día de la recuperación.
            _avoqado: expect.objectContaining({
              receivedByMerchantAccountId: 'ma_1',
              tarifaCongeladaAlIngreso: expect.objectContaining({ pricing: expect.objectContaining({ merchantAccountId: 'ma_1' }) }),
            }),
          }),
        }),
      }),
    )
  })
})

describe('reconcileAngelPayWebhookForPayment — guardas de coexistencia (2026-07-29)', () => {
  const basePayment = {
    id: 'pay_guard_1',
    idempotencyKey: 'idem-guard',
    referenceNumber: '260727999999',
    venueId: 'venue_g',
    amount: 100,
    tipAmount: 0,
  }

  beforeEach(() => {
    ;[
      mockedProviderEventLogFindMany,
      mockedProviderEventLogUpdate,
      mockedPaymentFindUnique,
      mockedPaymentUpdate,
      mockedMerchantAccountFindUnique,
      mockedActivityLogCreate,
    ].forEach(m => m.mockReset())
    mockedPaymentFindUnique.mockResolvedValue({ processorData: null })
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 1 })
    mockedPaymentUpdate.mockResolvedValue({})
    mockedActivityLogCreate.mockResolvedValue({})
  })

  it('un pago Blumon NUNCA vincula eventos angelpay- (guard por proveedor)', async () => {
    mockedMerchantAccountFindUnique.mockResolvedValue({ provider: { code: 'BLUMON' } })

    await reconcileAngelPayWebhookForPayment({ ...basePayment, merchantAccountId: 'ma_blumon' })

    expect(mockedProviderEventLogFindMany).not.toHaveBeenCalled()
  })

  it('el query de eventos queda acotado al venue del pago (o legacy sin venue)', async () => {
    mockedMerchantAccountFindUnique.mockResolvedValue({ provider: { code: 'ANGELPAY' } })
    mockedProviderEventLogFindMany.mockResolvedValue([])

    await reconcileAngelPayWebhookForPayment({ ...basePayment, merchantAccountId: 'ma_ap' })

    const where = mockedProviderEventLogFindMany.mock.calls[0][0].where
    // Dos cláusulas y sólo dos: el venue del pago (o legacy sin venue) y, desde S4, la exclusión de los
    // eventos que un worker está reconciliando bajo lease vigente (el backfill no puede pisar su reclamo).
    expect(where.AND).toHaveLength(2)
    expect(where.AND[0]).toEqual({ OR: [{ venueId: 'venue_g' }, { venueId: null }] })
    expect(where.AND[1]).toEqual({ OR: [{ leaseUntil: null }, { leaseUntil: { lte: expect.any(Date) } }] })
    const cota = where.AND[1].OR[1].leaseUntil.lte as Date
    expect(Math.abs(cota.getTime() - Date.now())).toBeLessThan(5_000)
  })

  it('match por llave débil (transactionId) con monto distinto: se SALTA, no estampa (anti-robo de webhook)', async () => {
    mockedMerchantAccountFindUnique.mockResolvedValue({ provider: { code: 'ANGELPAY' } })
    mockedProviderEventLogFindMany.mockResolvedValue([
      {
        id: 'evt_weak',
        payload: {
          event_type: 'send_transaction',
          // Solo coincide transactionId (llave débil); integratorReference es de OTRO pago
          payload: { amount: '000000099900', integratorReference: 'idem-de-otro', transactionId: '260727999999' },
        },
      },
    ])

    await reconcileAngelPayWebhookForPayment({ ...basePayment, merchantAccountId: 'ma_ap' })

    expect(mockedExecuteRaw).not.toHaveBeenCalled()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    expect(mockedProviderEventLogUpdate).not.toHaveBeenCalled()
  })

  it('mismatch en backfill: _avoqado.receivedBy difiere del comercio registrado → flag + ActivityLog', async () => {
    mockedMerchantAccountFindUnique.mockResolvedValue({ provider: { code: 'ANGELPAY' } })
    mockedProviderEventLogFindMany.mockResolvedValue([
      {
        id: 'evt_mm',
        payload: {
          event_type: 'send_transaction',
          _avoqado: { receivedByMerchantAccountId: 'ma_receptor' },
          payload: { amount: '000000010000', integratorReference: 'idem-guard', transactionId: '260727999999' },
        },
      },
    ])

    await reconcileAngelPayWebhookForPayment({ ...basePayment, merchantAccountId: 'ma_registrado' })

    expect(estampa('pay_guard_1').angelpayWebhook).toEqual(
      expect.objectContaining({
        merchantMismatch: true,
        receivedByMerchantAccountId: 'ma_receptor',
        recordedMerchantAccountId: 'ma_registrado',
      }),
    )
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED', errorReason: 'MERCHANT_MISMATCH' }),
      }),
    )
    expect(mockedActivityLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'ANGELPAY_MERCHANT_MISMATCH', entityId: 'pay_guard_1' }),
      }),
    )
  })

  it('regresión: mismo comercio receptor y registrado → PROCESSED limpio, sin flag ni ActivityLog', async () => {
    mockedMerchantAccountFindUnique.mockResolvedValue({ provider: { code: 'ANGELPAY' } })
    mockedProviderEventLogFindMany.mockResolvedValue([
      {
        id: 'evt_ok',
        payload: {
          event_type: 'send_transaction',
          _avoqado: { receivedByMerchantAccountId: 'ma_mismo' },
          payload: { amount: '000000010000', integratorReference: 'idem-guard', transactionId: '260727999999' },
        },
      },
    ])

    await reconcileAngelPayWebhookForPayment({ ...basePayment, merchantAccountId: 'ma_mismo' })

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED', errorReason: null }),
      }),
    )
    expect(mockedActivityLogCreate).not.toHaveBeenCalled()
  })
})

describe('Codex R5-4 · TODA escritura por identidad DÉBIL se decide bajo el candado del evento y relee el vínculo S1', () => {
  const linkMock = () => (prisma as any).terminalPaymentAttemptLink.findUnique as jest.Mock
  const queryRaw = () => (prisma as any).$queryRaw as jest.Mock
  /** La comprobación previa no ve el vínculo; bajo el candado sí (la ventana de la carrera). */
  const vinculoBajoElCandado = () =>
    linkMock()
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ requestId: 'req-1', venueId: 'venue_1', terminalId: 't1', createdAt: new Date() })
  const sinVinculo = () => linkMock().mockReset().mockResolvedValue(null)

  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogFindMany,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentFindUnique,
      mockedPaymentUpdate,
      mockedMerchantAccountUpdate,
      mockedMerchantAccountFindUnique,
      mockedActivityLogCreate,
    ].forEach(m => m.mockReset())
    queryRaw().mockClear()
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogUpdate.mockResolvedValue({ count: 1 })
    mockedMerchantAccountUpdate.mockResolvedValue({})
    mockedActivityLogCreate.mockResolvedValue({})
    mockedPaymentUpdate.mockResolvedValue({})
  })
  afterEach(() => sinVinculo())

  // El candado (`FOR UPDATE` sobre el evento, con el marcador SQL «evento») se toma ANTES de cualquier escritura (huella o evento).
  // Codex R15-1: se identifica por su marcador — el INGRESO también hace un `FOR UPDATE` sobre `ProviderEventLog` (la recuperación
  // de los ingresos sin candado) y no es el candado del escritor débil.
  const candadoAntesDeEscribir = () => {
    const indice = queryRaw().mock.calls.findIndex(([sql]) => Array.isArray(sql) && sql.join('?').includes('/* evento */'))
    expect(indice).toBeGreaterThanOrEqual(0)
    const candado = queryRaw().mock.calls[indice]
    expect((candado![0] as string[]).join('?')).toContain('"ProviderEventLog"')
    expect((candado![0] as string[]).join('?')).toContain('FOR UPDATE')
    const ordenDelCandado = queryRaw().mock.invocationCallOrder[indice]
    expect(mockedExecuteRaw.mock.invocationCallOrder.length).toBeGreaterThan(0)
    for (const orden of mockedExecuteRaw.mock.invocationCallOrder) expect(orden).toBeGreaterThan(ordenDelCandado)
    // Las DECISIONES sobre el evento (status / errorReason / paymentId) van después del candado. El fechado del INGRESO
    // (`data: { createdAt }`, Codex R14-1) ocurre antes, en la transacción del ingreso, y no es una escritura del escritor débil.
    const decisiones = mockedProviderEventLogUpdate.mock.calls
      .map((args, i) => ({
        data: (args[0] as { data?: Record<string, unknown> })?.data,
        orden: mockedProviderEventLogUpdate.mock.invocationCallOrder[i],
      }))
      .filter(({ data }) => !(data && Object.keys(data).length === 1 && 'createdAt' in data))
    expect(decisiones.length).toBeGreaterThan(0)
    for (const { orden } of decisiones) expect(orden).toBeGreaterThan(ordenDelCandado)
    // El vínculo se relee DESPUÉS del candado.
    const relecturas = linkMock().mock.invocationCallOrder.filter(o => o > ordenDelCandado)
    expect(relecturas.length).toBeGreaterThan(0)
  }

  const discrepancia = () =>
    processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { integratorReference: 'ref-d', amount: '000000010550', status: 'approved', transactionId: 'tx_d' },
      } as any,
      eventId: 'msg_disc_lock',
      merchantAccount: TEST_MERCHANT,
      retryDelaysMs: [0],
    })

  it('DISCREPANCIA sin vínculo: se escribe (angelpayDiscrepancy + ERROR/AMOUNT_MISMATCH), pero sólo DESPUÉS del candado y de releer S1', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_disc_lock' })
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_d', amount: 100, processorData: null, venueId: 'venue_1' })
    sinVinculo()
    const result = await discrepancia()
    expect(result.action).toBe('DISCREPANCY')
    expect(estampa('pay_d').angelpayDiscrepancy).toEqual(expect.objectContaining({ webhookAmount: 105.5, recordedAmount: 100 }))
    candadoAntesDeEscribir()
  })

  it('DISCREPANCIA con vínculo BAJO el candado: NO se estampa angelpayDiscrepancy ni se cierra el evento como ERROR — se decide por el vínculo', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_disc_race' })
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_d', amount: 100, processorData: null, venueId: 'venue_1' })
    vinculoBajoElCandado()
    const result = await discrepancia()
    expect(result.action).not.toBe('DISCREPANCY')
    expect(estampas().filter(e => e.paymentId === 'pay_d')).toHaveLength(0)
    expect(mockedProviderEventLogUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR', errorReason: 'AMOUNT_MISMATCH', paymentId: 'pay_d' }) }),
    )
  })

  const cruce = () =>
    processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        payload: { amount: '000000006000', integratorReference: 'idem-cross-lock', transactionId: '260727125955', status: 'approved' },
      } as any,
      eventId: 'msg_cross_lock',
      merchantAccount: TEST_MERCHANT as any,
      retryDelaysMs: [0],
    })
  const pagoDelHermano = {
    id: 'pay_cross_lock',
    amount: 60,
    tipAmount: 0,
    processorData: null,
    venueId: 'venue_1',
    merchantAccountId: 'ma_other',
  }

  it('CRUCE DE COMERCIO sin vínculo: se escribe (huella con merchantMismatch + PROCESSED/MERCHANT_MISMATCH), sólo DESPUÉS del candado y de releer S1', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_cross_lock' })
    mockedMerchantAccountFindUnique.mockResolvedValue({ angelpayUserAccount: { venueId: 'venue_1' } })
    mockedPaymentFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pagoDelHermano)
    sinVinculo()
    const result = await cruce()
    expect(result.action).toBe('MATCHED_WRONG_MERCHANT')
    expect(estampa('pay_cross_lock').angelpayWebhook).toEqual(expect.objectContaining({ merchantMismatch: true }))
    candadoAntesDeEscribir()
  })

  it('CRUCE DE COMERCIO con vínculo BAJO el candado: NO se estampa el Payment del hermano ni se cierra MERCHANT_MISMATCH — se decide por el vínculo', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_cross_race' })
    mockedMerchantAccountFindUnique.mockResolvedValue({ angelpayUserAccount: { venueId: 'venue_1' } })
    mockedPaymentFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(pagoDelHermano)
    vinculoBajoElCandado()
    const result = await cruce()
    expect(result.action).not.toBe('MATCHED_WRONG_MERCHANT')
    expect(estampas().filter(e => e.paymentId === 'pay_cross_lock')).toHaveLength(0)
    expect(mockedProviderEventLogUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorReason: 'MERCHANT_MISMATCH', paymentId: 'pay_cross_lock' }) }),
    )
    expect(mockedActivityLogCreate).not.toHaveBeenCalled()
  })

  const legacySinLlave = {
    id: 'pay_legacy_lock',
    idempotencyKey: null,
    referenceNumber: 'tx_lock_1',
    venueId: 'venue_x',
    amount: 100,
    tipAmount: 0,
  }
  const eventoDeOtroIntento = {
    id: 'evt_pending_lock',
    eventId: 'angelpay-msg_pending_lock',
    payload: {
      event_type: 'send_transaction',
      payload: { amount: '000000010000', integratorReference: 'idem-K', transactionId: 'tx_lock_1', status: 'approved' },
    },
  }

  it('BACKFILL sin vínculo para la llave del evento: reclama y estampa, sólo DESPUÉS del candado y de releer S1', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([eventoDeOtroIntento])
    mockedPaymentFindUnique.mockResolvedValue({ processorData: null })
    sinVinculo()
    await reconcileAngelPayWebhookForPayment(legacySinLlave as any)
    expect(estampa('pay_legacy_lock').angelpayWebhook).toEqual(expect.objectContaining({ integratorReference: 'idem-K' }))
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSED', paymentId: 'pay_legacy_lock' }) }),
    )
    candadoAntesDeEscribir()
  })

  it('BACKFILL con vínculo BAJO el candado (el intento de la llave ya tiene dueño): NO reclama ni estampa — lo confirma el worker por el vínculo', async () => {
    mockedProviderEventLogFindMany.mockResolvedValue([eventoDeOtroIntento])
    mockedPaymentFindUnique.mockResolvedValue({ processorData: null })
    vinculoBajoElCandado()
    await reconcileAngelPayWebhookForPayment(legacySinLlave as any)
    expect(estampas().filter(e => e.paymentId === 'pay_legacy_lock')).toHaveLength(0)
    expect(mockedProviderEventLogUpdate).not.toHaveBeenCalled()
  })
})
