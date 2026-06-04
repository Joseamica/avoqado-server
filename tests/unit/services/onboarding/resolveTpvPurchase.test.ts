// Test the DB-backed hydration of step9 for the onboarding wizard. The pure
// parser is covered by v2Step9.test.ts — this file covers the side-effectful
// fallback that resolves the most-recent TerminalOrder when step9 is empty.
//
// Contract: returns { tpvOrderId, skipped }. We deliberately don't return
// the order's status here — the frontend fetches full order details via the
// existing tpvOrderService.getOrder endpoint to avoid state denormalization.

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    onboardingProgress: { findUnique: jest.fn() },
    terminalOrder: { findFirst: jest.fn() },
    venue: { findFirst: jest.fn() },
  },
}))

import { resolveTpvPurchaseForOnboarding } from '../../../../src/services/onboarding/onboardingProgress.service'

const prisma = require('../../../../src/utils/prismaClient').default

describe('resolveTpvPurchaseForOnboarding', () => {
  beforeEach(() => {
    prisma.onboardingProgress.findUnique.mockReset()
    prisma.terminalOrder.findFirst.mockReset()
    prisma.venue.findFirst.mockReset()
  })

  it('returns nulls when there is no onboarding progress', async () => {
    prisma.onboardingProgress.findUnique.mockResolvedValue(null)
    const result = await resolveTpvPurchaseForOnboarding('org-1')
    expect(result).toEqual({ tpvOrderId: null, skipped: false })
  })

  it('returns the order id from step9 without re-fetching the order', async () => {
    prisma.onboardingProgress.findUnique.mockResolvedValue({
      id: 'p-1',
      organizationId: 'org-1',
      v2SetupData: {
        step9: { tpvPurchase: { tpvOrderId: 'order-step9', skipped: false } },
      },
    })

    const result = await resolveTpvPurchaseForOnboarding('org-1')
    expect(result).toEqual({ tpvOrderId: 'order-step9', skipped: false })
    // Does NOT fall back to the venue query when step9 already has an order.
    // Frontend fetches full order details via the existing tpvOrderService.
    expect(prisma.venue.findFirst).not.toHaveBeenCalled()
    expect(prisma.terminalOrder.findFirst).not.toHaveBeenCalled()
  })

  it('respects step9.skipped=true and does NOT fall back to recent orders', async () => {
    prisma.onboardingProgress.findUnique.mockResolvedValue({
      id: 'p-1',
      organizationId: 'org-1',
      v2SetupData: { step9: { tpvPurchase: { tpvOrderId: null, skipped: true } } },
    })

    const result = await resolveTpvPurchaseForOnboarding('org-1')
    expect(result).toEqual({ tpvOrderId: null, skipped: true })
    expect(prisma.venue.findFirst).not.toHaveBeenCalled()
    expect(prisma.terminalOrder.findFirst).not.toHaveBeenCalled()
  })

  it('falls back to the most-recent TerminalOrder for the org venue when step9 is empty', async () => {
    prisma.onboardingProgress.findUnique.mockResolvedValue({
      id: 'p-1',
      organizationId: 'org-1',
      v2SetupData: { step2: { businessName: 'X' } }, // no step9
    })
    prisma.venue.findFirst.mockResolvedValue({ id: 'venue-1' })
    prisma.terminalOrder.findFirst.mockResolvedValue({ id: 'order-recent' })

    const result = await resolveTpvPurchaseForOnboarding('org-1')
    expect(result).toEqual({ tpvOrderId: 'order-recent', skipped: false })
    expect(prisma.terminalOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venue-1' },
        orderBy: { createdAt: 'desc' },
      }),
    )
  })

  it('returns nulls when fallback finds no venue', async () => {
    prisma.onboardingProgress.findUnique.mockResolvedValue({
      id: 'p-1',
      organizationId: 'org-1',
      v2SetupData: {},
    })
    prisma.venue.findFirst.mockResolvedValue(null)

    const result = await resolveTpvPurchaseForOnboarding('org-1')
    expect(result).toEqual({ tpvOrderId: null, skipped: false })
  })

  it('returns nulls when fallback finds a venue but no order', async () => {
    prisma.onboardingProgress.findUnique.mockResolvedValue({
      id: 'p-1',
      organizationId: 'org-1',
      v2SetupData: {},
    })
    prisma.venue.findFirst.mockResolvedValue({ id: 'venue-1' })
    prisma.terminalOrder.findFirst.mockResolvedValue(null)

    const result = await resolveTpvPurchaseForOnboarding('org-1')
    expect(result).toEqual({ tpvOrderId: null, skipped: false })
  })
})
