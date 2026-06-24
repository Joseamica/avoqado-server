/**
 * getEffectivePricing — effectiveAt + per-account resolution (PR-2 · T1)
 *
 * Two additions, both backward-compatible (3rd optional `opts` arg):
 *   1. `effectiveAt` — the function used `new Date()` internally (B4 bug), so a
 *      historical recompute would price at TODAY's rate. Now the caller passes
 *      the payment's date and the active-window filter respects it.
 *   2. `merchantAccountId` — per-account pricing (VenuePricingStructure.merchantAccountId,
 *      added in PR-1) wins over the legacy accountType-keyed rows. Forward-compatible:
 *      no per-account rows exist yet, so today it always falls through to the
 *      legacy accountType path (zero behavior change for live calls).
 */

import { getEffectivePricing } from '@/services/organization-payment-config.service'
import { AccountType } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

describe('getEffectivePricing — effectiveAt + per-account (T1)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('uses the provided effectiveAt (not now) in the active-window filter', async () => {
    const at = new Date('2026-02-15T18:00:00Z')
    prismaMock.venuePricingStructure.findMany.mockResolvedValue([{ id: 'p1' } as any])

    await getEffectivePricing('venue-1', AccountType.PRIMARY, { effectiveAt: at })

    expect(prismaMock.venuePricingStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: 'venue-1',
          accountType: AccountType.PRIMARY,
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
        }),
      }),
    )
  })

  it('resolves per-account pricing FIRST when merchantAccountId is provided', async () => {
    const at = new Date('2026-02-15T18:00:00Z')
    prismaMock.venuePricingStructure.findMany.mockResolvedValueOnce([{ id: 'per-account' } as any])

    const result = await getEffectivePricing('venue-1', AccountType.SECONDARY, { merchantAccountId: 'm-2', effectiveAt: at })

    expect(prismaMock.venuePricingStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: 'venue-1', merchantAccountId: 'm-2' }) }),
    )
    expect(result).toEqual({ pricing: [{ id: 'per-account' }], source: 'venue' })
  })

  it('falls back to legacy accountType pricing (merchantAccountId IS NULL) when no per-account row exists', async () => {
    const at = new Date('2026-02-15T18:00:00Z')
    prismaMock.venuePricingStructure.findMany
      .mockResolvedValueOnce([]) // (A) venue per-account lookup → empty
      .mockResolvedValueOnce([{ id: 'legacy' } as any]) // (B) legacy accountType lookup → hit
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org-1' } as any)
    prismaMock.organizationPricingStructure.findMany.mockResolvedValue([]) // org per-account → empty

    const result = await getEffectivePricing('venue-1', AccountType.SECONDARY, { merchantAccountId: 'm-2', effectiveAt: at })

    // The legacy query selects only legacy rows (merchantAccountId IS NULL).
    expect(prismaMock.venuePricingStructure.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: 'venue-1', accountType: AccountType.SECONDARY, merchantAccountId: null }),
      }),
    )
    expect(result).toEqual({ pricing: [{ id: 'legacy' }], source: 'venue' })
  })

  it('is backward-compatible: called with (venueId, accountType) only → uses now + legacy path', async () => {
    prismaMock.venuePricingStructure.findMany.mockResolvedValue([{ id: 'legacy-pri' } as any])

    const result = await getEffectivePricing('venue-1', AccountType.PRIMARY)

    expect(prismaMock.venuePricingStructure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: 'venue-1', accountType: AccountType.PRIMARY, merchantAccountId: null }),
      }),
    )
    expect(result).toEqual({ pricing: [{ id: 'legacy-pri' }], source: 'venue' })
  })
})
