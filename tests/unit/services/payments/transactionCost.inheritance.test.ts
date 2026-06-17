/**
 * TransactionCost Service — Org-Level Inheritance Tests
 *
 * Tests that createTransactionCost and findActiveVenuePricingStructure
 * correctly use the org→venue inheritance system via getEffectivePaymentConfig
 * and getEffectivePricing.
 *
 * Key business scenario: A venue with NO VenuePaymentConfig should still
 * process payments by inheriting the OrganizationPaymentConfig.
 */

import {
  createTransactionCost,
  findActiveVenuePricingStructure,
  findActiveProviderCostStructure,
} from '@/services/payments/transactionCost.service'
import { PaymentMethod, CardBrand, OriginSystem } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

// Mock the organization-payment-config service (the inheritance layer)
const mockGetEffectivePaymentConfig = jest.fn()
const mockGetEffectivePricing = jest.fn()

jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: (...args: any[]) => mockGetEffectivePaymentConfig(...args),
  getEffectivePricing: (...args: any[]) => mockGetEffectivePricing(...args),
}))

// ===== Test Data Factories =====

const VENUE_ID = 'venue-001'
const ORG_ID = 'org-001'
const MERCHANT_ACCOUNT_ID = 'merchant-001'
const PAYMENT_ID = 'payment-001'

function createMockPayment(overrides?: Partial<any>) {
  return {
    id: PAYMENT_ID,
    venueId: VENUE_ID,
    amount: { toString: () => '500.00' },
    tipAmount: { toString: () => '75.00' },
    method: PaymentMethod.CREDIT_CARD,
    cardBrand: CardBrand.VISA,
    originSystem: OriginSystem.AVOQADO,
    type: 'SALE',
    processorData: null,
    createdAt: new Date('2026-02-15T18:00:00Z'),
    venue: { id: VENUE_ID, organizationId: ORG_ID },
    ...overrides,
  }
}

function createMockPaymentConfig(source: 'venue' | 'organization') {
  return {
    config: {
      primaryAccount: {
        id: MERCHANT_ACCOUNT_ID,
        displayName: 'Test Merchant',
      },
      secondaryAccount: null,
      tertiaryAccount: null,
    },
    source,
  }
}

function createMockProviderCostStructure() {
  return {
    id: 'cost-001',
    merchantAccountId: MERCHANT_ACCOUNT_ID,
    active: true,
    debitRate: { toString: () => '0.015' },
    creditRate: { toString: () => '0.018' },
    amexRate: { toString: () => '0.025' },
    internationalRate: { toString: () => '0.035' },
    fixedCostPerTransaction: { toString: () => '0' },
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
  }
}

function createMockPricingStructure(source: 'venue' | 'organization') {
  return {
    pricing: [
      {
        id: `pricing-${source}-001`,
        active: true,
        debitRate: { toString: () => '0.022' },
        creditRate: { toString: () => '0.025' },
        amexRate: { toString: () => '0.035' },
        internationalRate: { toString: () => '0.038' },
        fixedFeePerTransaction: { toString: () => '0' },
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
      },
    ],
    source,
  }
}

// ===== Tests =====

describe('TransactionCost Service — Org Inheritance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createTransactionCost', () => {
    it('should use org config when venue has no VenuePaymentConfig', async () => {
      // Setup: Payment exists, org config returned (no venue config)
      prismaMock.payment.findUnique.mockResolvedValue(createMockPayment())
      mockGetEffectivePaymentConfig.mockResolvedValue(createMockPaymentConfig('organization'))
      prismaMock.providerCostStructure.findFirst.mockResolvedValue(createMockProviderCostStructure())
      mockGetEffectivePricing.mockResolvedValue(createMockPricingStructure('organization'))
      prismaMock.transactionCost.create.mockResolvedValue({ id: 'tc-001' })

      const result = await createTransactionCost(PAYMENT_ID)

      // Verify it called getEffectivePaymentConfig (inheritance service)
      expect(mockGetEffectivePaymentConfig).toHaveBeenCalledWith(VENUE_ID)

      // Verify it used the org merchant account
      expect(prismaMock.transactionCost.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            merchantAccountId: MERCHANT_ACCOUNT_ID,
            paymentId: PAYMENT_ID,
          }),
        }),
      )

      expect(result).not.toBeNull()
      expect(result!.transactionCost.id).toBe('tc-001')
    })

    it('should use venue config when venue has VenuePaymentConfig', async () => {
      const venueSpecificMerchantId = 'merchant-venue-specific'
      prismaMock.payment.findUnique.mockResolvedValue(createMockPayment())
      mockGetEffectivePaymentConfig.mockResolvedValue({
        config: {
          primaryAccount: { id: venueSpecificMerchantId, displayName: 'Venue Merchant' },
          secondaryAccount: null,
          tertiaryAccount: null,
        },
        source: 'venue',
      })
      prismaMock.providerCostStructure.findFirst.mockResolvedValue({
        ...createMockProviderCostStructure(),
        merchantAccountId: venueSpecificMerchantId,
      })
      mockGetEffectivePricing.mockResolvedValue(createMockPricingStructure('venue'))
      prismaMock.transactionCost.create.mockResolvedValue({ id: 'tc-002' })

      await createTransactionCost(PAYMENT_ID)

      // Verify it used the VENUE-specific merchant account
      expect(prismaMock.transactionCost.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            merchantAccountId: venueSpecificMerchantId,
          }),
        }),
      )
    })

    it('should throw when neither venue nor org config exists', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(createMockPayment())
      mockGetEffectivePaymentConfig.mockResolvedValue(null)

      await expect(createTransactionCost(PAYMENT_ID)).rejects.toThrow(/has no payment configuration/)
    })

    it('should skip CASH payments', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(createMockPayment({ method: PaymentMethod.CASH }))

      const result = await createTransactionCost(PAYMENT_ID)
      expect(result).toBeNull()
      expect(mockGetEffectivePaymentConfig).not.toHaveBeenCalled()
    })

    it('should skip non-AVOQADO origin payments', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(createMockPayment({ originSystem: OriginSystem.POS_SOFTRESTAURANT }))

      const result = await createTransactionCost(PAYMENT_ID)
      expect(result).toBeNull()
    })

    it('should log the config source for debugging', async () => {
      prismaMock.payment.findUnique.mockResolvedValue(createMockPayment())
      mockGetEffectivePaymentConfig.mockResolvedValue(createMockPaymentConfig('organization'))
      prismaMock.providerCostStructure.findFirst.mockResolvedValue(createMockProviderCostStructure())
      mockGetEffectivePricing.mockResolvedValue(createMockPricingStructure('organization'))
      prismaMock.transactionCost.create.mockResolvedValue({ id: 'tc-003' })

      await createTransactionCost(PAYMENT_ID)

      // The function should have proceeded without error using org config
      expect(prismaMock.transactionCost.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('findActiveVenuePricingStructure', () => {
    it('should return org pricing when venue has no VenuePricingStructure', async () => {
      mockGetEffectivePricing.mockResolvedValue(createMockPricingStructure('organization'))

      const result = await findActiveVenuePricingStructure(VENUE_ID, 'PRIMARY')

      expect(mockGetEffectivePricing).toHaveBeenCalledWith(VENUE_ID, 'PRIMARY')
      expect(result).not.toBeNull()
      expect(result!.id).toBe('pricing-organization-001')
    })

    it('should return venue pricing when venue has VenuePricingStructure', async () => {
      mockGetEffectivePricing.mockResolvedValue(createMockPricingStructure('venue'))

      const result = await findActiveVenuePricingStructure(VENUE_ID, 'PRIMARY')

      expect(result).not.toBeNull()
      expect(result!.id).toBe('pricing-venue-001')
    })

    it('should return null when no pricing exists at any level', async () => {
      mockGetEffectivePricing.mockResolvedValue(null)

      const result = await findActiveVenuePricingStructure(VENUE_ID, 'PRIMARY')

      expect(result).toBeNull()
    })

    it('should return null when pricing array is empty', async () => {
      mockGetEffectivePricing.mockResolvedValue({ pricing: [], source: 'organization' })

      const result = await findActiveVenuePricingStructure(VENUE_ID, 'PRIMARY')

      expect(result).toBeNull()
    })
  })

  describe('findActiveProviderCostStructure', () => {
    it('should find active cost structure for merchant account', async () => {
      const mockCostStructure = createMockProviderCostStructure()
      prismaMock.providerCostStructure.findFirst.mockResolvedValue(mockCostStructure)

      const result = await findActiveProviderCostStructure(MERCHANT_ACCOUNT_ID)

      expect(prismaMock.providerCostStructure.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            merchantAccountId: MERCHANT_ACCOUNT_ID,
            active: true,
          }),
        }),
      )
      expect(result).not.toBeNull()
    })

    it('should return null when no active cost structure exists', async () => {
      prismaMock.providerCostStructure.findFirst.mockResolvedValue(null)

      const result = await findActiveProviderCostStructure(MERCHANT_ACCOUNT_ID)

      expect(result).toBeNull()
    })
  })
})

/**
 * TransactionCost Service — Account Routing
 *
 * A venue can have several merchant accounts (PRIMARY / SECONDARY / TERTIARY),
 * each with its OWN venue pricing. The TPV routing layer records which account
 * actually processed the card on `Payment.merchantAccountId`. The cost engine
 * MUST honor that account so the venue is charged with the pricing of the
 * account that ran the transaction — not always the PRIMARY one.
 *
 * Regression: amaena's cards ran on the SECONDARY account "Amaena - B" (8%),
 * but costs were calculated against PRIMARY "Amaena - A" (3.6%+IVA = 4.18%),
 * silently undercharging the venue on every payment.
 */
describe('TransactionCost Service — Account Routing', () => {
  const PRIMARY_ID = 'merchant-primary'
  const SECONDARY_ID = 'merchant-secondary'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // Pricing keyed off the resolved accountType, mirroring amaena:
  // PRIMARY = 3.6% (no-tax→would be 4.18%), SECONDARY = 8% (tax incl.).
  function pricingByAccountType(_venueId: string, accountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY') {
    const rate = accountType === 'SECONDARY' ? '0.08' : '0.036'
    return {
      pricing: [
        {
          id: `pricing-${accountType}`,
          active: true,
          debitRate: { toString: () => rate },
          creditRate: { toString: () => rate },
          amexRate: { toString: () => rate },
          internationalRate: { toString: () => rate },
          fixedFeePerTransaction: { toString: () => '0' },
          includesTax: true, // keep effective rate == base rate for a clean assertion
          taxRate: { toString: () => '0.16' },
          effectiveFrom: new Date('2026-01-01'),
          effectiveTo: null,
        },
      ],
      source: 'venue' as const,
    }
  }

  function configWithTwoAccounts() {
    return {
      config: {
        primaryAccount: { id: PRIMARY_ID, displayName: 'Amaena - A' },
        secondaryAccount: { id: SECONDARY_ID, displayName: 'Amaena - B' },
        tertiaryAccount: null,
      },
      source: 'venue',
    }
  }

  it('uses the SECONDARY account + pricing when the payment was processed by the secondary merchant account', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(
      createMockPayment({ merchantAccountId: SECONDARY_ID, tipAmount: { toString: () => '0.00' } }),
    )
    mockGetEffectivePaymentConfig.mockResolvedValue(configWithTwoAccounts())
    prismaMock.providerCostStructure.findFirst.mockResolvedValue({
      ...createMockProviderCostStructure(),
      merchantAccountId: SECONDARY_ID,
    })
    mockGetEffectivePricing.mockImplementation((venueId: string, accountType: any) => pricingByAccountType(venueId, accountType))
    prismaMock.transactionCost.create.mockResolvedValue({ id: 'tc-sec' })

    await createTransactionCost(PAYMENT_ID)

    // Venue pricing resolved for the SECONDARY slot, not PRIMARY
    expect(mockGetEffectivePricing).toHaveBeenCalledWith(VENUE_ID, 'SECONDARY')
    // Provider cost looked up against the SECONDARY merchant account
    expect(prismaMock.providerCostStructure.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ merchantAccountId: SECONDARY_ID }) }),
    )
    // Cost row recorded against the SECONDARY merchant account, with its 8% rate
    expect(prismaMock.transactionCost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          merchantAccountId: SECONDARY_ID,
          venueRate: expect.closeTo(0.08, 5),
          venueChargeAmount: expect.closeTo(40, 2), // $500 × 8%
        }),
      }),
    )
  })

  it('falls back to PRIMARY when payment.merchantAccountId is null', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(createMockPayment({ merchantAccountId: null, tipAmount: { toString: () => '0.00' } }))
    mockGetEffectivePaymentConfig.mockResolvedValue(configWithTwoAccounts())
    prismaMock.providerCostStructure.findFirst.mockResolvedValue({
      ...createMockProviderCostStructure(),
      merchantAccountId: PRIMARY_ID,
    })
    mockGetEffectivePricing.mockImplementation((venueId: string, accountType: any) => pricingByAccountType(venueId, accountType))
    prismaMock.transactionCost.create.mockResolvedValue({ id: 'tc-pri' })

    await createTransactionCost(PAYMENT_ID)

    expect(mockGetEffectivePricing).toHaveBeenCalledWith(VENUE_ID, 'PRIMARY')
    expect(prismaMock.transactionCost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ merchantAccountId: PRIMARY_ID }) }),
    )
  })
})
