/**
 * TransactionCost Service — Roster ON path (PR-2 · T2)
 *
 * When a venue's `VenuePaymentConfig.rosterRolloutEnabled` is true, cost resolution
 * switches from the 3 legacy slots to the venue ROSTER (VenueMerchantAccount, which
 * already includes materialized org accounts). This lets a 4th+ account resolve
 * correctly instead of silently falling back to PRIMARY (the amaena bug class).
 *
 * The flag defaults OFF, so every EXISTING test (transactionCost.inheritance.test.ts,
 * transactionCost.service.test.ts) exercises the unchanged slot path — that suite is
 * the zero-regression guarantee for the OFF path.
 */

import { createTransactionCost } from '@/services/payments/transactionCost.service'
import { PaymentMethod, CardBrand, OriginSystem } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

const mockGetEffectivePaymentConfig = jest.fn()
const mockGetEffectivePricing = jest.fn()
jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: (...a: any[]) => mockGetEffectivePaymentConfig(...a),
  getEffectivePricing: (...a: any[]) => mockGetEffectivePricing(...a),
}))

const VENUE_ID = 'venue-001'
const ORG_ID = 'org-001'
const PAYMENT_ID = 'pay-001'
const PRIMARY_ID = 'm-primary'
const SECONDARY_ID = 'm-secondary'
const FOURTH_ID = 'm-fourth'

function mkPayment(overrides?: Partial<any>) {
  return {
    id: PAYMENT_ID,
    venueId: VENUE_ID,
    amount: { toString: () => '500.00' },
    tipAmount: { toString: () => '0.00' },
    method: PaymentMethod.CREDIT_CARD,
    cardBrand: CardBrand.VISA,
    originSystem: OriginSystem.AVOQADO,
    type: 'SALE',
    processorData: null,
    createdAt: new Date('2026-02-15T18:00:00Z'),
    venue: { id: VENUE_ID, organizationId: ORG_ID },
    merchantAccountId: SECONDARY_ID,
    ...overrides,
  }
}

function configRosterOn() {
  return {
    config: {
      rosterRolloutEnabled: true,
      primaryAccount: { id: PRIMARY_ID, displayName: 'Primary' },
      secondaryAccount: { id: SECONDARY_ID, displayName: 'Secondary' },
      tertiaryAccount: null,
    },
    source: 'venue',
  }
}

function providerCost(merchantAccountId: string) {
  return {
    id: 'pc',
    merchantAccountId,
    active: true,
    debitRate: { toString: () => '0.018' },
    creditRate: { toString: () => '0.018' },
    amexRate: { toString: () => '0.025' },
    internationalRate: { toString: () => '0.035' },
    fixedCostPerTransaction: { toString: () => '0' },
    includesTax: true,
  }
}

function pricing(rate: string, source: 'venue' | 'organization' = 'venue', id = 'pricing-x') {
  return {
    pricing: [
      {
        id,
        active: true,
        debitRate: { toString: () => rate },
        creditRate: { toString: () => rate },
        amexRate: { toString: () => rate },
        internationalRate: { toString: () => rate },
        fixedFeePerTransaction: { toString: () => '0' },
        includesTax: true,
        taxRate: { toString: () => '0.16' },
      },
    ],
    source,
  }
}

describe('createTransactionCost — roster ON path (T2)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('ON: payment on a SECONDARY roster account uses SECONDARY pricing + records the account', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(mkPayment())
    mockGetEffectivePaymentConfig.mockResolvedValue(configRosterOn())
    prismaMock.venueMerchantAccount.findMany.mockResolvedValue([
      { merchantAccountId: PRIMARY_ID, legacySlotType: 'PRIMARY' },
      { merchantAccountId: SECONDARY_ID, legacySlotType: 'SECONDARY' },
    ] as any)
    prismaMock.providerCostStructure.findFirst.mockResolvedValue(providerCost(SECONDARY_ID) as any)
    mockGetEffectivePricing.mockResolvedValue(pricing('0.08'))
    prismaMock.transactionCost.create.mockResolvedValue({ id: 'tc-on-sec' } as any)

    await createTransactionCost(PAYMENT_ID)

    // Resolved the venue roster (not just the 3 slots).
    expect(prismaMock.venueMerchantAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE_ID } }),
    )
    // Priced per-account aware, with the payment's date and the account's legacySlotType.
    expect(mockGetEffectivePricing).toHaveBeenCalledWith(
      VENUE_ID,
      'SECONDARY',
      expect.objectContaining({ merchantAccountId: SECONDARY_ID, effectiveAt: expect.any(Date) }),
    )
    // Cost recorded against the SECONDARY account at its 8% rate, with audit fields.
    expect(prismaMock.transactionCost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          merchantAccountId: SECONDARY_ID,
          venueRate: expect.closeTo(0.08, 5),
          venueChargeAmount: expect.closeTo(40, 2), // $500 × 8%
          pricingStructureSource: 'VENUE',
          venuePricingFallbackUsed: false,
        }),
      }),
    )
  })

  it('ON: payment on a 4th account (no legacy slot, no per-account pricing) → PRIMARY pricing fallback + flag', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(mkPayment({ merchantAccountId: FOURTH_ID }))
    mockGetEffectivePaymentConfig.mockResolvedValue(configRosterOn())
    prismaMock.venueMerchantAccount.findMany.mockResolvedValue([
      { merchantAccountId: PRIMARY_ID, legacySlotType: 'PRIMARY' },
      { merchantAccountId: SECONDARY_ID, legacySlotType: 'SECONDARY' },
      { merchantAccountId: FOURTH_ID, legacySlotType: null }, // headroom account, no slot
    ] as any)
    prismaMock.providerCostStructure.findFirst.mockResolvedValue(providerCost(FOURTH_ID) as any)
    // No per-account / legacy pricing for the 4th account; only PRIMARY has a rate.
    mockGetEffectivePricing.mockImplementation((_v: string, accountType: any) =>
      accountType === 'PRIMARY' ? pricing('0.036') : { pricing: [], source: 'venue' },
    )
    prismaMock.transactionCost.create.mockResolvedValue({ id: 'tc-on-4th' } as any)

    await createTransactionCost(PAYMENT_ID)

    // Fell back to PRIMARY pricing (never worse than PRIMARY).
    expect(mockGetEffectivePricing).toHaveBeenCalledWith(VENUE_ID, 'PRIMARY', expect.objectContaining({ effectiveAt: expect.any(Date) }))
    // Cost still recorded against the account that processed it, flagged as a pricing fallback.
    expect(prismaMock.transactionCost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          merchantAccountId: FOURTH_ID,
          venueRate: expect.closeTo(0.036, 5),
          venuePricingFallbackUsed: true,
        }),
      }),
    )
  })

  it('OFF (no flag): still uses the legacy slot path — does NOT query the roster', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(mkPayment())
    mockGetEffectivePaymentConfig.mockResolvedValue({
      config: {
        // no rosterRolloutEnabled → OFF
        primaryAccount: { id: PRIMARY_ID },
        secondaryAccount: { id: SECONDARY_ID },
        tertiaryAccount: null,
      },
      source: 'venue',
    })
    prismaMock.providerCostStructure.findFirst.mockResolvedValue(providerCost(SECONDARY_ID) as any)
    mockGetEffectivePricing.mockResolvedValue(pricing('0.08'))
    prismaMock.transactionCost.create.mockResolvedValue({ id: 'tc-off' } as any)

    await createTransactionCost(PAYMENT_ID)

    // OFF path must NOT touch the roster table.
    expect(prismaMock.venueMerchantAccount.findMany).not.toHaveBeenCalled()
    // OFF path calls getEffectivePricing with exactly 2 args (legacy signature).
    expect(mockGetEffectivePricing).toHaveBeenCalledWith(VENUE_ID, 'SECONDARY')
  })
})
