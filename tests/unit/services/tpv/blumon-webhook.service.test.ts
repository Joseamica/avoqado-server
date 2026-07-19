import { reconcileBlumonEvent } from '@/services/tpv/blumon-webhook.service'
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
    ;[mockedPaymentFindFirst, mockedPaymentFindMany, mockedPaymentUpdate, mockedProviderEventLogUpdate].forEach(m => m.mockReset())
    mockedPaymentUpdate.mockResolvedValue({})
    mockedProviderEventLogUpdate.mockResolvedValue({})
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
