import { contextoGuardado, reconcileBlumonEvent } from '@/services/tpv/blumon-webhook.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $executeRaw: jest.fn(),
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

// Codex R12-10: los escritores de Blumon parchan `processorData` con un `||` ATÓMICO en Postgres, nunca con un `update` desde
// una copia leída antes. Lo que se afirma es el SQL del parche (llaves propias) y que `payment.update` no se toca.
const mockedExecuteRaw = prisma.$executeRaw as unknown as jest.Mock
const sqlDelParche = () =>
  mockedExecuteRaw.mock.calls.map(([strings, ...values]: [TemplateStringsArray, ...unknown[]]) => ({ sql: strings.join('?'), values }))
const mockedPaymentFindFirst = prisma.payment.findFirst as jest.Mock
// Matching resolves candidates per tier via findMany (deterministic tiered
// matching, 2026-07-18) — the payload below is identified by operationNumber,
// which is the strong tier, so a genuine amount discrepancy is still surfaced.
const mockedPaymentFindMany = prisma.payment.findMany as jest.Mock
const mockedPaymentUpdate = prisma.payment.update as jest.Mock
const mockedProviderEventLogUpdate = prisma.providerEventLog.update as jest.Mock

/**
 * Blumon charges the card the FULL amount the customer pays — base + tip. We
 * store that split across two columns (`amount` = base, `tipAmount` = tip).
 * The reconciliation must therefore compare the webhook amount against
 * `amount + tipAmount`, NOT `amount` alone. Comparing against `amount` alone
 * mis-flagged every tipped TPV payment as an AMOUNT DISCREPANCY (prod, 67/67
 * historical "discrepancies" were exactly the tip — investigation 2026-06-24).
 */
describe('reconcileBlumonEvent — tip is part of the charged amount', () => {
  beforeEach(() => {
    ;[mockedPaymentFindFirst, mockedPaymentFindMany, mockedPaymentUpdate, mockedProviderEventLogUpdate, mockedExecuteRaw].forEach(m =>
      m.mockReset(),
    )
    mockedPaymentUpdate.mockResolvedValue({})
    mockedProviderEventLogUpdate.mockResolvedValue({})
    mockedExecuteRaw.mockResolvedValue(1)
  })

  const tippedPayload = {
    amount: '77.00', // Blumon charged base($70) + tip($7) = $77 to the card
    reference: '20260624115138',
    operationNumber: 20294305,
    authorizationCode: 'AUTH123',
    membership: 'MEMB1',
    operationType: 'VENTA',
    codeResponse: '00',
  } as any

  it('MATCHES when webhook amount == base + tip (regression: tip was excluded)', async () => {
    mockedPaymentFindMany.mockResolvedValue([
      {
        id: 'pay_tip',
        amount: 70,
        tipAmount: 7,
        processorData: null,
        order: null,
      },
    ])

    const result = await reconcileBlumonEvent('evt_tip', tippedPayload, { scopeVenueIds: ['venue_1'] })

    expect(result.action).toBe('MATCHED')
    expect(result.paymentId).toBe('pay_tip')
    // R12-10: parche atómico con las llaves de Blumon, idempotente por `blumonWebhookReceived` en la MISMA sentencia.
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    const [parche] = sqlDelParche()
    expect(parche.sql).toMatch(/UPDATE "Payment"[\s\S]*END \|\| \?::jsonb[\s\S]*"processorData" \? \?/)
    expect(parche.values).toEqual(expect.arrayContaining(['pay_tip', 'blumonWebhookReceived']))
    expect(JSON.parse(parche.values[0] as string)).toMatchObject({
      blumonOperationNumber: 20294305,
      blumonAuthCode: 'AUTH123',
      blumonMembership: 'MEMB1',
    })
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_tip' },
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    )
  })

  it('still flags a GENUINE discrepancy (webhook != base + tip)', async () => {
    mockedPaymentFindMany.mockResolvedValue([
      {
        id: 'pay_bad',
        amount: 70,
        tipAmount: 7, // base + tip = 77, but Blumon says 100 → real $23 mismatch
        processorData: null,
        order: null,
      },
    ])

    const result = await reconcileBlumonEvent('evt_bad', { ...tippedPayload, amount: '100.00' }, { scopeVenueIds: ['venue_1'] })

    expect(result.action).toBe('DISCREPANCY')
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    const [parche] = sqlDelParche()
    expect(parche.sql).toMatch(/UPDATE "Payment"[\s\S]*END \|\| \?::jsonb/)
    expect(JSON.parse(parche.values[0] as string)).toMatchObject({
      blumonDiscrepancy: expect.objectContaining({ blumonAmount: 100, recordedAmount: 77 }),
    })
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_bad' },
        data: expect.objectContaining({ status: 'ERROR', errorReason: 'AMOUNT_MISMATCH' }),
      }),
    )
  })

  it('MATCHES a tipless payment unchanged (tipAmount = 0)', async () => {
    mockedPaymentFindMany.mockResolvedValue([
      {
        id: 'pay_notip',
        amount: 77,
        tipAmount: 0,
        processorData: null,
        order: null,
      },
    ])

    const result = await reconcileBlumonEvent('evt_notip', tippedPayload, { scopeVenueIds: ['venue_1'] })

    expect(result.action).toBe('MATCHED')
  })
})

// Tarea 6: la red sólo recupera por vínculo con el contexto que el ingreso guardó con su forma EXACTA; lo demás no crea dinero.
describe('contextoGuardado — forma exacta o null', () => {
  const valido = {
    attemptId: 'att_1',
    requestId: 'req_1',
    linkVenueId: 'venue_1',
    linkTerminalId: 'n86abc',
    merchantAccountId: 'ma_1',
    receiverVenueId: 'venue_1',
    terminalSerialEfectivo: 'N86ABC',
  }
  const con = (ctx: unknown) => ({ amount: '100.00', _avoqado: { contextoDelIngreso: ctx } })

  it('devuelve el contexto completo; receiverVenueId null es válido (⇒ LINK_VENUE_MISMATCH en el núcleo)', () => {
    expect(contextoGuardado(con(valido))).toEqual(valido)
    expect(contextoGuardado(con({ ...valido, receiverVenueId: null }))).toEqual({ ...valido, receiverVenueId: null })
  })

  it.each(['attemptId', 'requestId', 'linkVenueId', 'linkTerminalId', 'merchantAccountId', 'terminalSerialEfectivo'])(
    'sin %s, vacío o no textual ⇒ null',
    campo => {
      const sinCampo: Record<string, unknown> = { ...valido }
      delete sinCampo[campo]
      expect(contextoGuardado(con(sinCampo))).toBeNull()
      expect(contextoGuardado(con({ ...valido, [campo]: '' }))).toBeNull()
      expect(contextoGuardado(con({ ...valido, [campo]: 7 }))).toBeNull()
    },
  )

  it.each([
    ['receiverVenueId ausente', (({ receiverVenueId: _r, ...resto }) => resto)(valido)],
    ['receiverVenueId vacío', { ...valido, receiverVenueId: '' }],
    ['receiverVenueId no textual', { ...valido, receiverVenueId: 5 }],
  ])('%s ⇒ null', (_caso, ctx) => {
    expect(contextoGuardado(con(ctx))).toBeNull()
  })

  it.each([
    ['payload null', null],
    ['payload sin _avoqado', { amount: '100.00' }],
    ['_avoqado sin contexto', { _avoqado: { receivedByMerchantAccountId: 'ma_1' } }],
    ['contexto no objeto', con('att_1')],
    ['contexto null', con(null)],
  ])('%s ⇒ null', (_caso, payload) => {
    expect(contextoGuardado(payload)).toBeNull()
  })
})
