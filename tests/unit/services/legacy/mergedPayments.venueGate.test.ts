/**
 * Legacy QR bridge — VENUE GATE guarantee (2026-06-30).
 *
 * The MindForm legacy QR bridge merges payments from the old `avo-pwa` database into the
 * unified analytics. It is deliberately gated to ONE venue (MindForm) via an exported
 * constant used as a grep-marker ("delete every MINDFORM_NEW_VENUE_ID gate when native QR
 * ships"). This test locks the guarantee that EVERY OTHER venue is fully isolated: a
 * non-MindForm venue must NEVER trigger the legacy DB query (no getLegacyPayments call,
 * no legacy pool spin-up). If someone ever moves/removes the gate, this fails loudly.
 *
 * Pure test — no production behavior change.
 */
import { fetchPaymentsForAnalytics } from '../../../../src/services/legacy/mergedPayments.service'

const MINDFORM = 'cmisvi38o001fhr2828ygmxi2'
const mockFindMany = jest.fn()
const mockGetLegacy = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { payment: { findMany: (...a: unknown[]) => mockFindMany(...(a as [])) } },
}))
jest.mock('@/services/legacy/qrPayments.legacy.service', () => ({
  MINDFORM_NEW_VENUE_ID: 'cmisvi38o001fhr2828ygmxi2',
  getLegacyPayments: (...a: unknown[]) => mockGetLegacy(...(a as [])),
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

const filters = { fromDate: new Date('2026-06-01T06:00:00.000Z'), toDate: new Date('2026-07-01T05:59:59.999Z') }
const nativeRow = {
  id: 'p1',
  amount: 100,
  tipAmount: 0,
  method: 'CASH',
  type: 'REGULAR',
  status: 'COMPLETED',
  createdAt: new Date('2026-06-15T12:00:00Z'),
}

beforeEach(() => {
  jest.clearAllMocks()
  mockFindMany.mockResolvedValue([nativeRow])
})

describe('fetchPaymentsForAnalytics — legacy QR bridge venue gate', () => {
  it('🔒 a NON-MindForm venue NEVER touches the legacy DB (no getLegacyPayments call)', async () => {
    const out = await fetchPaymentsForAnalytics('some-other-venue-id', filters as never)
    expect(mockGetLegacy).not.toHaveBeenCalled() // ← the guarantee: other venues are fully isolated
    expect(out).toHaveLength(1) // only the native payment, nothing legacy
    expect(out[0].id).toBe('p1')
  })

  it('a second unrelated venue is also isolated (defense-in-depth)', async () => {
    await fetchPaymentsForAnalytics('restaurante-cualquiera', filters as never)
    expect(mockGetLegacy).not.toHaveBeenCalled()
  })

  it('MindForm DOES merge legacy QR rows (the bridge still works)', async () => {
    mockGetLegacy.mockResolvedValueOnce({
      rows: [
        {
          id: 'L1',
          amount: 250,
          tipAmount: 0,
          method: 'CASH',
          type: 'REGULAR',
          status: 'COMPLETED',
          createdAt: new Date('2026-06-20T12:00:00Z'),
        },
      ],
      total: 1,
    })
    const out = await fetchPaymentsForAnalytics(MINDFORM, filters as never)
    expect(mockGetLegacy).toHaveBeenCalledTimes(1) // only MindForm hits the legacy DB
    expect(out.map(p => p.id).sort()).toEqual(['L1', 'p1']) // native + legacy merged
  })

  it('MindForm legacy rows respect the same filters (drops a REFUND when includeRefunds=false)', async () => {
    mockGetLegacy.mockResolvedValueOnce({
      rows: [
        {
          id: 'L1',
          amount: 250,
          tipAmount: 0,
          method: 'CASH',
          type: 'REGULAR',
          status: 'COMPLETED',
          createdAt: new Date('2026-06-20T12:00:00Z'),
        },
        {
          id: 'Lref',
          amount: -50,
          tipAmount: 0,
          method: 'CASH',
          type: 'REFUND',
          status: 'COMPLETED',
          createdAt: new Date('2026-06-21T12:00:00Z'),
        },
      ],
      total: 2,
    })
    const out = await fetchPaymentsForAnalytics(MINDFORM, { ...filters, includeRefunds: false } as never)
    expect(out.map(p => p.id).sort()).toEqual(['L1', 'p1']) // the legacy REFUND is excluded, like native
  })
})
