/**
 * classifyMerchantResolution (PR-2 · T3) — durable merchant-resolution mark.
 */
import { classifyMerchantResolution } from '@/services/payments/merchantResolution'
import { MerchantResolutionStatus } from '@prisma/client'

describe('classifyMerchantResolution (T3)', () => {
  it('no provided account → no mark (manual/QR/legacy)', () => {
    expect(classifyMerchantResolution({ provided: null, final: null })).toEqual({
      merchantResolutionStatus: null,
      merchantResolutionReason: null,
      originalMerchantAccountId: null,
    })
    expect(classifyMerchantResolution({ provided: undefined, final: undefined }).merchantResolutionStatus).toBeNull()
  })

  it('final === provided → RESOLVED clean (no original kept)', () => {
    expect(classifyMerchantResolution({ provided: 'm-1', final: 'm-1' })).toEqual({
      merchantResolutionStatus: MerchantResolutionStatus.RESOLVED,
      merchantResolutionReason: null,
      originalMerchantAccountId: null,
    })
  })

  it('provided stale but recovered to a different account → RESOLVED + recovered_via_serial + original kept', () => {
    expect(classifyMerchantResolution({ provided: 'm-stale', final: 'm-recovered' })).toEqual({
      merchantResolutionStatus: MerchantResolutionStatus.RESOLVED,
      merchantResolutionReason: 'recovered_via_serial',
      originalMerchantAccountId: 'm-stale',
    })
  })

  it('provided present but nulled (TIER 3) → UNRESOLVED + original kept for reconciliation', () => {
    expect(classifyMerchantResolution({ provided: 'm-phantom', final: null })).toEqual({
      merchantResolutionStatus: MerchantResolutionStatus.UNRESOLVED,
      merchantResolutionReason: 'unresolved_nulled',
      originalMerchantAccountId: 'm-phantom',
    })
    // undefined final is treated the same as null
    expect(classifyMerchantResolution({ provided: 'm-phantom', final: undefined }).merchantResolutionStatus).toBe(
      MerchantResolutionStatus.UNRESOLVED,
    )
  })
})
