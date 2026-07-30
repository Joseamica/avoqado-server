import { buildBlumonEventId, reconcileBlumonEvent, validateBlumonWebhookPayload } from '@/services/tpv/blumon-webhook.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    providerEventLog: {
      update: jest.fn(),
    },
  },
}))

const mockedFindFirst = prisma.payment.findFirst as jest.Mock
const mockedFindMany = prisma.payment.findMany as jest.Mock
const mockedPaymentUpdate = prisma.payment.update as jest.Mock
const mockedEventLogUpdate = prisma.providerEventLog.update as jest.Mock

const ventaPayload = {
  amount: '100.00',
  reference: '260718120000',
  operationNumber: 99000001,
  authorizationCode: 'AUTH99',
  operationType: 'VENTA',
  codeResponse: '00',
} as any

/** Matching candidate that satisfies the amount check (base + tip == 100.00). */
const matchingPayment = {
  id: 'pay_1',
  amount: 100,
  tipAmount: 0,
  processorData: null,
  order: null,
}

beforeEach(() => {
  ;[mockedFindFirst, mockedFindMany, mockedPaymentUpdate, mockedEventLogUpdate].forEach(m => m.mockReset())
  mockedPaymentUpdate.mockResolvedValue({})
  mockedEventLogUpdate.mockResolvedValue({})
  // Resolve on the first attempt so the retry backoff (0/2s/3s) never runs.
  mockedFindFirst.mockResolvedValue(matchingPayment)
  mockedFindMany.mockResolvedValue([matchingPayment])
})

/**
 * Refunds share `referenceNumber` with the sale they reverse, so a VENTA
 * webhook can select a REFUND row and "confirm" it — writing Blumon operation
 * data onto the wrong Payment. The guard mirrors payment.tpv.service.ts:1413.
 */
describe('Task 1 — VENTA matching excludes REFUND payments', () => {
  it('the search WHERE excludes type REFUND', async () => {
    await reconcileBlumonEvent('evt_t1', ventaPayload, { scopeVenueIds: ['venue_1'] })

    const call = mockedFindMany.mock.calls[0] ?? mockedFindFirst.mock.calls[0]
    expect(call).toBeDefined()
    expect(call[0].where).toEqual(expect.objectContaining({ type: { not: 'REFUND' } }))
  })
})

const candidate = (id: string, amount: number, tip = 0) => ({
  id,
  amount,
  tipAmount: tip,
  processorData: null,
  order: { id: 'o1', orderNumber: 1, venueId: 'venue_1', venue: { id: 'venue_1', name: 'V', status: 'ACTIVE' } },
})

/**
 * The weak keys are NOT unique in production (verified 2026-07-18):
 * `referenceNumber` is a timestamp to the second (yyMMddHHmmss) and 6-digit
 * issuer auth codes recycle — both collide TODAY with DIFFERENT amounts. The
 * amount is only compared AFTER a candidate is chosen, and both the MATCHED
 * and DISCREPANCY branches write to that Payment — so a wrong pick is never
 * caught. Hence: amount belongs in the KEY for weak tiers, and a partial
 * reference must never auto-link.
 */
describe('Task 2 — deterministic tiered matching', () => {
  it('empty venue scope → PENDING without searching', async () => {
    const result = await reconcileBlumonEvent('evt_t2a', ventaPayload, { scopeVenueIds: [] })

    expect(result.action).toBe('PENDING')
    expect(mockedFindMany).not.toHaveBeenCalled()
    expect(mockedFindFirst).not.toHaveBeenCalled()
  })

  it('two candidates in a tier → AMBIGUOUS, never auto-links', async () => {
    mockedFindMany.mockResolvedValue([candidate('pay_a', 100), candidate('pay_b', 100)])

    const result = await reconcileBlumonEvent('evt_t2b', ventaPayload, { scopeVenueIds: ['venue_1'] })

    expect(result.action).toBe('AMBIGUOUS')
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    expect(mockedEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorReason: 'AMBIGUOUS_MATCH' }) }),
    )
  })

  it('exactly one candidate still matches (regression)', async () => {
    mockedFindMany.mockResolvedValue([candidate('pay_one', 100)])

    const result = await reconcileBlumonEvent('evt_t2c', ventaPayload, { scopeVenueIds: ['venue_1'] })

    expect(['MATCHED', 'RECONCILED']).toContain(result.action)
    expect(result.paymentId).toBe('pay_one')
  })

  it('weak tier (partial reference) NEVER auto-links, even with a single candidate', async () => {
    const referenceOnly = { amount: '100.00', reference: '260718120000', operationType: 'VENTA', codeResponse: '00' } as any
    mockedFindMany
      .mockResolvedValueOnce([]) // REFERENCE_EXACT finds nothing
      .mockResolvedValueOnce([candidate('pay_weak', 100)]) // REFERENCE_PARTIAL finds one

    const result = await reconcileBlumonEvent('evt_t2d', referenceOnly, { scopeVenueIds: ['venue_1'] })

    expect(result.action).toBe('NO_AUTO_MATCH')
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    expect(mockedEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorReason: 'WEAK_MATCH_ONLY' }) }),
    )
  })

  it('amount is part of the KEY in weak tiers — a wrong-amount row is never selected', async () => {
    const referenceOnly = { amount: '100.00', reference: '260718120000', operationType: 'VENTA', codeResponse: '00' } as any
    mockedFindMany.mockResolvedValue([candidate('pay_wrong_amount', 999)])

    const result = await reconcileBlumonEvent('evt_t2e', referenceOnly, { scopeVenueIds: ['venue_1'] })

    expect(result.paymentId).toBeUndefined()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })
})

/**
 * Incidente 2026-07-30 (Mindform): el webhook llegó 1.97 s ANTES de que el
 * Payment existiera, así que los niveles fuertes (OP_NUMBER, REFERENCE_EXACT)
 * no encontraron nada y la cascada cayó a AUTH_CODE — cuya llave era solo
 * `venue + authorizationNumber` (+ monto como filtro). Los auth de 6 dígitos se
 * reciclan, así que enganchó un pago de HACE 20 DÍAS: mismo venue, mismo $110,
 * mismo auth 436971, pero VISA en vez de MASTERCARD y otro número de operación.
 *
 * La guarda de ambigüedad no salvó nada porque el competidor legítimo aún no
 * existía: había UN solo candidato, y era el equivocado. Al consumirse ahí, el
 * evento nunca llegó a PENDING, así que ni el reintento de 24 h ni el backfill
 * —que lo habrían resuelto en segundos— llegaron a correr.
 *
 * Dos cotas independientes, cada una habría bastado sola:
 *   1. ventana temporal en AUTH_CODE (un auth reciclado a 20 días no es defendible)
 *   2. la marca de la tarjeta debe cuadrar cuando el payload la trae
 */
describe('AUTH_CODE — llave débil acotada (incidente cross-time 2026-07-30)', () => {
  const authOnlyPayload = {
    amount: '110.00',
    authorizationCode: '436971',
    brand: 'MASTERCARD',
    operationType: 'VENTA',
    codeResponse: '00',
  } as any

  it('acota AUTH_CODE por fecha — un pago viejo queda FUERA del universo de búsqueda', async () => {
    mockedFindMany.mockResolvedValue([])

    await reconcileBlumonEvent('evt_auth_window', authOnlyPayload, { scopeVenueIds: ['venue_1'] })

    const authCall = mockedFindMany.mock.calls.find(c => c[0]?.where?.authorizationNumber === '436971')
    expect(authCall).toBeDefined()
    // Sin esta cota, el pago de hace 20 días es un candidato válido.
    expect(authCall![0].where.createdAt).toEqual(expect.objectContaining({ gte: expect.any(Date) }))
  })

  it('la ventana es de días, no de meses (un auth reciclado a 20 días NO debe alcanzarse)', async () => {
    mockedFindMany.mockResolvedValue([])

    await reconcileBlumonEvent('evt_auth_window_size', authOnlyPayload, { scopeVenueIds: ['venue_1'] })

    const authCall = mockedFindMany.mock.calls.find(c => c[0]?.where?.authorizationNumber === '436971')
    // Banda, no igualdad: el servicio calcula su `gte` unos ms ANTES que este
    // Date.now(), así que un `<= 48` exacto solo pasa si ambos caen en el mismo
    // milisegundo. Lo que importa es el ORDEN DE MAGNITUD — días, no meses.
    const horas = (Date.now() - (authCall![0].where.createdAt.gte as Date).getTime()) / 36e5
    expect(horas).toBeGreaterThan(1) // no tan corta que rompa un replay de cola offline
    expect(horas).toBeLessThan(72) // ni tan larga que alcance un auth reciclado (el caso real: 20 días)
  })

  it('exige que cuadre la MARCA cuando el payload la trae — VISA nunca satisface un webhook MASTERCARD', async () => {
    // El caso real: el único candidato en ventana es de otra marca.
    mockedFindMany.mockResolvedValue([{ ...candidate('pay_visa_vieja', 110), cardBrand: 'VISA' }])

    const result = await reconcileBlumonEvent('evt_auth_brand', authOnlyPayload, { scopeVenueIds: ['venue_1'] })

    expect(result.paymentId).toBeUndefined()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })

  it('la marca correcta SÍ engancha (regresión — no romper el camino feliz)', async () => {
    mockedFindMany.mockResolvedValue([{ ...candidate('pay_mc_real', 110), cardBrand: 'MASTERCARD' }])

    const result = await reconcileBlumonEvent('evt_auth_brand_ok', authOnlyPayload, { scopeVenueIds: ['venue_1'] })

    expect(['MATCHED', 'RECONCILED']).toContain(result.action)
    expect(result.paymentId).toBe('pay_mc_real')
  })

  it('un pago sin marca registrada NO se descarta (los AngelPay/legacy no traen cardBrand)', async () => {
    mockedFindMany.mockResolvedValue([{ ...candidate('pay_sin_marca', 110), cardBrand: null }])

    const result = await reconcileBlumonEvent('evt_auth_brand_null', authOnlyPayload, { scopeVenueIds: ['venue_1'] })

    expect(['MATCHED', 'RECONCILED']).toContain(result.action)
    expect(result.paymentId).toBe('pay_sin_marca')
  })

  it('los niveles FUERTES no llevan cota temporal (un replay tardío debe seguir enganchando)', async () => {
    mockedFindMany.mockResolvedValue([])

    await reconcileBlumonEvent('evt_strong_no_window', ventaPayload, { scopeVenueIds: ['venue_1'] })

    const opCall = mockedFindMany.mock.calls.find(c => JSON.stringify(c[0]?.where ?? {}).includes('99000001'))
    expect(opCall).toBeDefined()
    expect(opCall![0].where.createdAt).toBeUndefined()
  })
})

/**
 * `operationNumber` is Blumon's strongest per-transaction key, yet the payload
 * validator rejected any webhook identified ONLY by it. And a payload with no
 * usable key can never match — leaving it PENDING would make the cron retry it
 * forever, so it must terminate as ERROR/NO_MATCH_FIELDS with a visible alert.
 */
describe('Task 3 — operationNumber is a valid identifier; keyless payloads alert', () => {
  it('a payload identified ONLY by operationNumber is accepted', () => {
    const p = { amount: '100.00', operationNumber: 99000001, operationType: 'VENTA', codeResponse: '00' }
    expect(validateBlumonWebhookPayload(p)).toBe(true)
  })

  it('payload with NO matchable key → ERROR + NO_MATCH_FIELDS (not eternal PENDING)', async () => {
    const keyless = { amount: '50.00', operationType: 'VENTA', codeResponse: '00' } as any

    const result = await reconcileBlumonEvent('evt_t3b', keyless, { scopeVenueIds: ['venue_1'] })

    expect(result.action).toBe('ERROR')
    expect(mockedEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorReason: 'NO_MATCH_FIELDS' }) }),
    )
  })
})

/**
 * A reversal ran the SAME matching logic as a sale: it could confirm the wrong
 * row, and its non-match fired the "charge without record" alert for money that
 * is LEAVING. It also shared the sale's eventId, so the unique index treated a
 * refund as a duplicate of its own sale.
 */
describe('Task 5 — reversals never run sale logic and get their own event id', () => {
  it('VENTA event id is unchanged (legacy-compatible)', () => {
    expect(buildBlumonEventId({ operationNumber: 21372460, reference: '20260716084615', operationType: 'VENTA' } as any)).toBe(
      'blumon-tpv-21372460-20260716084615',
    )
  })

  it('a reversal gets a distinct namespace (no collision with its sale)', () => {
    expect(buildBlumonEventId({ operationNumber: 21372460, reference: '20260716084615', operationType: 'DEVOLUCION' } as any)).toBe(
      'blumon-tpv-reversal-devolucion-21372460-20260716084615',
    )
  })

  it.each(['DEVOLUCION', 'CANCELACION'])('%s → REVERSAL_RECEIVED, no sale search, no orphan alert', async opType => {
    const reversal = { ...ventaPayload, operationType: opType } as any

    const result = await reconcileBlumonEvent('evt_t5', reversal, { scopeVenueIds: ['venue_1'] })

    expect(result.action).toBe('REVERSAL_RECEIVED')
    expect(mockedFindMany).not.toHaveBeenCalled()
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    expect(mockedEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED', errorReason: 'REVERSAL_UNMATCHED' }),
      }),
    )
  })
})
