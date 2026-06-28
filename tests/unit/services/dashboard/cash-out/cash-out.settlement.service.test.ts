/**
 * Unit tests (mock-first) — cash-out settlement sweep (the 18:15 corte runner).
 * Proves it discovers every CASH_OUT venue (org-level + venue-level) and runs
 * materialize → reconcile → report on each, aggregating the result.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    organizationModule: { findMany: jest.fn() },
    venueModule: { findMany: jest.fn() },
    venue: { findMany: jest.fn() },
  },
}))
jest.mock('@/utils/retry', () => ({ retry: (fn: () => unknown) => fn(), shouldRetryDbConnectionError: jest.fn() }))
jest.mock('@/services/dashboard/cash-out/cash-out.ledger.service', () => ({
  materializeEntries: jest.fn(),
  reconcileClawbacks: jest.fn(),
}))
jest.mock('@/services/dashboard/cash-out/cash-out.report.service', () => ({ generateDispersionReport: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { materializeEntries, reconcileClawbacks } from '@/services/dashboard/cash-out/cash-out.ledger.service'
import { generateDispersionReport } from '@/services/dashboard/cash-out/cash-out.report.service'
import { runCashOutSettlement } from '@/services/dashboard/cash-out/cash-out.settlement.service'

const p = prisma as unknown as {
  organizationModule: { findMany: jest.Mock }
  venueModule: { findMany: jest.Mock }
  venue: { findMany: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(materializeEntries as jest.Mock).mockResolvedValue({ created: 1 })
  ;(reconcileClawbacks as jest.Mock).mockResolvedValue({ clawedBack: 0 })
  ;(generateDispersionReport as jest.Mock).mockResolvedValue({ count: 1, rows: [], totalNet: '0', venueId: '' })
})

describe('cash-out settlement — runCashOutSettlement', () => {
  it('discovers org-level + venue-level CASH_OUT venues and sweeps each (materialize→reconcile→report)', async () => {
    p.organizationModule.findMany.mockResolvedValue([{ organizationId: 'org1' }])
    p.venue.findMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }]) // org1's venues
    p.venueModule.findMany.mockResolvedValue([{ venueId: 'v3' }]) // a venue-level enable

    const r = await runCashOutSettlement()

    expect(r.venues).toBe(3)
    expect(materializeEntries).toHaveBeenCalledTimes(3)
    expect(reconcileClawbacks).toHaveBeenCalledTimes(3)
    expect(generateDispersionReport).toHaveBeenCalledTimes(3)
    expect(r.created).toBe(3)
    expect(r.reported).toBe(3)
  })

  it('does nothing when no venue has the CASH_OUT module', async () => {
    p.organizationModule.findMany.mockResolvedValue([])
    p.venueModule.findMany.mockResolvedValue([])
    const r = await runCashOutSettlement()
    expect(r.venues).toBe(0)
    expect(materializeEntries).not.toHaveBeenCalled()
  })

  it('keeps going if one venue fails (one bad venue does not abort the corte)', async () => {
    p.organizationModule.findMany.mockResolvedValue([])
    p.venueModule.findMany.mockResolvedValue([{ venueId: 'v1' }, { venueId: 'v2' }])
    ;(materializeEntries as jest.Mock).mockRejectedValueOnce(new Error('boom')) // v1 fails
    const r = await runCashOutSettlement()
    expect(r.venues).toBe(2)
    expect(generateDispersionReport).toHaveBeenCalledTimes(1) // only v2 reached report
  })
})
