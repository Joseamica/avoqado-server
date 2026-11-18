import {
  buildBlumonEventId,
  centavosExactos,
  paraElLog,
  processBlumonPaymentWebhook,
  reconcileBlumonEvent,
  sinTitular,
  validateBlumonWebhookPayload,
} from '@/services/tpv/blumon-webhook.service'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $executeRaw: jest.fn().mockResolvedValue(1),
    payment: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    providerEventLog: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    terminal: {
      findUnique: jest.fn(),
    },
    merchantAccount: {
      findFirst: jest.fn(),
    },
    venuePaymentConfig: {
      findMany: jest.fn(),
    },
  },
}))

const mockedFindFirst = prisma.payment.findFirst as jest.Mock
const mockedFindMany = prisma.payment.findMany as jest.Mock
const mockedPaymentUpdate = prisma.payment.update as jest.Mock
const mockedEventLogUpdate = prisma.providerEventLog.update as jest.Mock
const mockedEventLogCreate = prisma.providerEventLog.create as jest.Mock
const mockedEventLogFindFirst = prisma.providerEventLog.findFirst as jest.Mock
const mockedTerminalFindUnique = prisma.terminal.findUnique as jest.Mock
const mockedMerchantFindFirst = prisma.merchantAccount.findFirst as jest.Mock
const mockedVenueConfigFindMany = prisma.venuePaymentConfig.findMany as jest.Mock

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
  ;[
    mockedFindFirst,
    mockedFindMany,
    mockedPaymentUpdate,
    mockedEventLogUpdate,
    mockedEventLogCreate,
    mockedEventLogFindFirst,
    mockedTerminalFindUnique,
    mockedMerchantFindFirst,
    mockedVenueConfigFindMany,
  ].forEach(m => m.mockReset())
  mockedEventLogCreate.mockResolvedValue({ id: 'evt_row' })
  mockedEventLogFindFirst.mockResolvedValue(null)
  mockedTerminalFindUnique.mockResolvedValue(null)
  mockedMerchantFindFirst.mockResolvedValue(null)
  mockedVenueConfigFindMany.mockResolvedValue([])
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
 * Incidente 2026-07-30 (Berthe, $9,324): un cobro real se descartó como
 * UNKNOWN_TERMINAL antes de llegar a la cascada.
 *
 * CAUSA: los SERIALES VIRTUALES son una estrategia deliberada de multi-merchant
 * (ver `.claude/rules/blumon-seriales-virtuales.md`). Un mismo aparato físico
 * lleva N afiliaciones en Blumon: la base + variantes con un dígito extra
 * (2840744167 → 28407441672). El serial virtual vive SOLO en
 * `MerchantAccount.blumonSerialNumber`; NO existe como fila en `Terminal`.
 *
 * El gate preguntaba únicamente por `Terminal` y tiraba el webhook. Dos líneas
 * más abajo, `resolveBlumonScope` — que ya corre en el mismo `Promise.all` — SÍ
 * lo resuelve. El sistema sabía de quién era; le preguntó a la tabla equivocada.
 *
 * El match sigue siendo EXACTO en ambas tablas: nada de comparación difusa de
 * seriales para rutear dinero.
 */
describe('Serial virtual (multi-merchant) — el gate acepta terminal O merchant', () => {
  const webhookSerialVirtual = {
    serialNumber: '28407441672', // afiliación virtual: existe en MerchantAccount, no en Terminal
    amount: '9324.00',
    operationNumber: 77000001,
    authorizationCode: 'AUTH77',
    operationType: 'VENTA',
    codeResponse: '00',
    lastFour: '1234',
    cardType: 'CREDITO',
    brand: 'VISA',
    bank: 'BANORTE',
  } as any

  it('NO descarta el webhook cuando el serial resuelve a un MerchantAccount', async () => {
    mockedTerminalFindUnique.mockResolvedValue(null) // no hay Terminal con ese serial
    mockedMerchantFindFirst.mockResolvedValue({ id: 'merchant_goia' }) // pero sí un merchant
    mockedVenueConfigFindMany.mockResolvedValue([{ venueId: 'venue_berthe' }])

    const result = await processBlumonPaymentWebhook(webhookSerialVirtual)

    expect(result.action).not.toBe('UNKNOWN_TERMINAL')
    expect(mockedEventLogCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorReason: 'UNKNOWN_TERMINAL' }) }),
    )
  })

  it('un serial ajeno (ni Terminal ni MerchantAccount) SÍ sigue siendo UNKNOWN_TERMINAL', async () => {
    mockedTerminalFindUnique.mockResolvedValue(null)
    mockedMerchantFindFirst.mockResolvedValue(null) // de otro integrador

    const result = await processBlumonPaymentWebhook({ ...webhookSerialVirtual, serialNumber: '99999999999' })

    expect(result.action).toBe('UNKNOWN_TERMINAL')
  })

  it('el camino normal (terminal física registrada) no cambia', async () => {
    mockedTerminalFindUnique.mockResolvedValue({ id: 'term_1', venueId: 'venue_berthe', serialNumber: 'AVQD-2840744167' })
    mockedMerchantFindFirst.mockResolvedValue(null)

    const result = await processBlumonPaymentWebhook({ ...webhookSerialVirtual, serialNumber: '2840744167' })

    expect(result.action).not.toBe('UNKNOWN_TERMINAL')
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

/**
 * R6 (hallazgo D4): ProviderEventLog.payload no guarda el nombre del titular. Va aquí y no en
 * blumon-webhook.service.test.ts (H2): este mock sí llega a los tres `create`.
 */
describe('R6 — la base no guarda el titular', () => {
  const conTitular = { ...ventaPayload, cardHolder: 'HOMER SIMPSON', bin: '411111', lastFour: '1111', arqc: 'A1B2C3D4E5F60718' }

  it.each([
    ['UNKNOWN_TERMINAL', { serialNumber: '99999999999' }],
    ['NOT_APPROVED', { codeResponse: '05', descriptionResponse: 'DECLINADA' }],
    ['PENDING', {}],
  ])('ProviderEventLog.payload nunca guarda cardHolder (%s)', async (_rama, cambios) => {
    await processBlumonPaymentWebhook({ ...conTitular, ...cambios })

    const guardado = mockedEventLogCreate.mock.calls[0][0].data
    if (_rama === 'PENDING') expect(guardado.status).toBe('PENDING')
    else expect(guardado.errorReason).toBe(_rama)
    expect(guardado.payload).not.toHaveProperty('cardHolder')
    // F6: el criptograma del chip (EMV) tampoco se guarda.
    expect(guardado.payload).not.toHaveProperty('arqc')
    expect(guardado.payload).toEqual(expect.objectContaining({ lastFour: '1111', bin: '411111' }))
  })

  // Arreglo ronda 1 (T6): el sello `_avoqado` lo escribe sólo el SERVIDOR; uno que traiga el aviso no se guarda en ninguna rama.
  it.each([
    ['UNKNOWN_TERMINAL', { serialNumber: '99999999999' }],
    ['NOT_APPROVED', { codeResponse: '05', descriptionResponse: 'DECLINADA' }],
    ['PENDING', {}],
  ])('ProviderEventLog.payload nunca guarda el _avoqado que trae el aviso (%s)', async (_rama, cambios) => {
    const sello = { contextoDelIngreso: { attemptId: 'a' }, tarifaCongeladaAlIngreso: { pricing: {} }, ingresoSinCandado: { en: 'x' } }
    await processBlumonPaymentWebhook({ ...conTitular, ...cambios, _avoqado: sello } as typeof conTitular)

    const guardado = mockedEventLogCreate.mock.calls[0][0].data
    expect(guardado.payload).not.toHaveProperty('_avoqado')
  })

  // Familia E (Codex r2 H7): lista BLANCA. Un campo que Blumon agregue (un dato EMV crudo) o un objeto anidado no se copian; sólo
  // queda su NOMBRE para saber que llegó algo nuevo.
  const conDesconocidos = { ...conTitular, tvr: '0000008000', emv: { track2: '4111111111111111D2512' } }
  it.each([
    ['UNKNOWN_TERMINAL', { serialNumber: '99999999999' }],
    ['NOT_APPROVED', { codeResponse: '05', descriptionResponse: 'DECLINADA' }],
    ['PENDING', {}],
  ])('lista blanca: un campo desconocido tipo EMV y un objeto anidado no se guardan, sólo sus nombres (%s)', async (_rama, cambios) => {
    await processBlumonPaymentWebhook({ ...conDesconocidos, ...cambios } as typeof conTitular)

    const guardado = mockedEventLogCreate.mock.calls[0][0].data.payload
    expect(guardado).not.toHaveProperty('tvr')
    expect(guardado).not.toHaveProperty('emv')
    expect(JSON.stringify(guardado)).not.toContain('0000008000')
    expect(JSON.stringify(guardado)).not.toContain('4111111111111111')
    expect(guardado.camposNoReconocidos).toEqual(['tvr', 'emv'])
  })

  it('lista blanca: sinTitular conserva lo que leen el emparejamiento, la conciliación y la red', () => {
    const completo = {
      ...conTitular,
      business: 'NEGOCIO',
      businessRfc: 'XAXX010101000',
      cardType: 'CREDITO',
      brand: 'VISA',
      bank: 'BANCO',
      authorizationCode: 'AUTH99',
      dateTransaction: '20/01/2021 18:24:38',
      authentication: 'pin',
      membership: 'M1',
      provideResponse: 'PR',
      aid: 'A0000000031010',
      serialNumber: '2841548628',
      realCounter: '7',
    }
    const esperado: Record<string, unknown> = { ...completo }
    delete esperado.cardHolder
    delete esperado.arqc
    expect(sinTitular(completo)).toEqual(esperado)
  })

  it('lista blanca: una llave conocida con un objeto dentro tampoco se copia (sólo su nombre)', () => {
    const raro = sinTitular({ ...ventaPayload, brand: { nombre: 'VISA', pan: '4111111111111111' } } as any) as any
    expect(raro).not.toHaveProperty('brand')
    expect(raro.camposNoReconocidos).toEqual(['brand'])
  })

  it('sinTitular no toca el payload original', () => {
    const copia = sinTitular(conTitular)
    expect(copia).not.toHaveProperty('cardHolder')
    expect(copia).not.toHaveProperty('arqc')
    expect(conTitular.cardHolder).toBe('HOMER SIMPSON')
    expect(conTitular.arqc).toBe('A1B2C3D4E5F60718')
  })

  // R3-7 (Codex r3): la lista blanca también mira el VALOR. Un campo de forma fija que no la cumple no se copia; el texto libre
  // lleva tope y toda racha de 12+ dígitos enmascarada; el receptor loguea sólo del cuerpo ya filtrado.
  describe('R3-7 — los valores también', () => {
    const PAN = '4111111111111111'
    const ramas = [
      ['UNKNOWN_TERMINAL', { serialNumber: '99999999999' }],
      ['NOT_APPROVED', { codeResponse: '05' }],
      ['PENDING', {}],
    ] as const
    let espias: jest.SpyInstance[] = []
    beforeEach(() => {
      espias = (['info', 'warn', 'error', 'debug'] as const).map(nivel => jest.spyOn(logger, nivel))
    })
    afterEach(() => espias.forEach(e => e.mockRestore()))
    const loLogueado = () => JSON.stringify(espias.flatMap(e => e.mock.calls))
    const guardado = () => mockedEventLogCreate.mock.calls[0][0].data

    it.each(ramas)('un PAN en lastFour, bin o aid no va ni a la base ni al log; su nombre sí (%s)', async (_rama, cambios) => {
      await processBlumonPaymentWebhook({ ...conTitular, ...cambios, lastFour: PAN, bin: PAN, aid: PAN })

      const p = guardado().payload
      expect(JSON.stringify(guardado())).not.toContain(PAN)
      expect(p).not.toHaveProperty('lastFour')
      expect(p).not.toHaveProperty('bin')
      expect(p).not.toHaveProperty('aid')
      expect(p.camposNoReconocidos).toEqual(expect.arrayContaining(['lastFour', 'bin', 'aid']))
      expect(loLogueado()).not.toContain(PAN)
    })

    it.each(ramas)(
      'descriptionResponse con una racha de 16 dígitos (también con espacios) ⇒ enmascarada en la base y en el log (%s)',
      async (_rama, cambios) => {
        await processBlumonPaymentWebhook({ ...conTitular, ...cambios, descriptionResponse: `TARJETA ${PAN} / 4111 1111 1111 1111 FIN` })

        const d = guardado().payload.descriptionResponse
        expect(d).toMatch(/^TARJETA .+ \/ .+ FIN$/)
        expect(d).not.toMatch(/\d{12}/)
        expect(JSON.stringify(guardado())).not.toContain('1111 1111')
        expect(loLogueado()).not.toContain(PAN)
        expect(loLogueado()).not.toContain('1111 1111')
      },
    )

    it('un rechazo con descriptionResponse objeto ⇒ el log del receptor no lo lleva', async () => {
      await processBlumonPaymentWebhook({ ...conTitular, codeResponse: '05', descriptionResponse: { pista: `${PAN}D2512` } } as any)

      expect(guardado().errorReason).toBe('NOT_APPROVED')
      const rechazo = espias[1].mock.calls.find(([m]) => String(m).includes('Non-approved'))
      expect(rechazo).toBeDefined()
      expect(rechazo![1].descriptionResponse).toBeUndefined()
      expect(loLogueado()).not.toContain(PAN)
    })

    it('el nombre de un campo con dígitos de tarjeta no se guarda: sólo se cuenta', async () => {
      await processBlumonPaymentWebhook({ ...conTitular, [PAN]: 'x', [`pan${PAN}`]: 'y', tvr: '1' } as any)

      const p = guardado().payload
      expect(JSON.stringify(p)).not.toContain(PAN)
      expect(p.camposNoReconocidos).toEqual(['tvr'])
      expect(p.camposNoReconocidosSinNombre).toBe(2)
      expect(loLogueado()).not.toContain(PAN)
    })

    it('el texto libre lleva tope de largo; los valores normales pasan igual (paraElLog también enmascara)', () => {
      const largo = sinTitular({ ...ventaPayload, descriptionResponse: 'A'.repeat(500), bank: 'BANCO' }) as any
      expect(largo.descriptionResponse.length).toBeLessThanOrEqual(120)
      expect(largo.bank).toBe('BANCO')
      expect(sinTitular({ ...ventaPayload, lastFour: '1234', bin: '41111111', aid: 'A0000000031010' })).toMatchObject({
        lastFour: '1234',
        bin: '41111111',
        aid: 'A0000000031010',
      })
      expect(JSON.stringify(paraElLog({ ...ventaPayload, descriptionResponse: `X ${PAN}` }))).not.toContain(PAN)
    })
  })
})

/** F11 (minor T5): el importe del aviso en centavos EXACTOS — sólo cadenas con hasta 2 decimales; lo demás es ilegible. */
describe('centavosExactos', () => {
  it.each([
    ['105.00', 10500], // base 100.00 + propina 5.00
    ['100.5', 10050],
    ['100', 10000],
    ['0.01', 1],
    ['0', 0],
    ['29150.00', 2915000],
  ])('%p ⇒ %p', (amount, centavos) => {
    expect(centavosExactos(amount)).toBe(centavos)
  })

  it.each([[100], [100.5], ['-1.00'], ['1.234'], ['1,000.00'], [' 100.00'], ['100.'], ['.50'], [''], [null], [undefined], ['1e3']])(
    '%p ⇒ null (ilegible)',
    amount => {
      expect(centavosExactos(amount)).toBeNull()
    },
  )
})
