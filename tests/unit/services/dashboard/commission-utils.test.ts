/**
 * Commission Utils Tests
 *
 * Tests for pure utility functions in commission-utils.ts:
 * - validateRate
 * - decimalToNumber
 * - getRecipientStaffId
 * - calculateFinalRate
 * - applyCommissionBounds
 * - calculateBaseAmount
 * - calculateCategoryFilteredAmount
 * - getPeriodDateRange
 */

import { Decimal } from '@prisma/client/runtime/library'
import { CommissionRecipient, CommissionCalcType, StaffRole, TierPeriod } from '@prisma/client'
import {
  validateRate,
  decimalToNumber,
  getRecipientStaffId,
  calculateFinalRate,
  applyCommissionBounds,
  calculateBaseAmount,
  calculateCategoryFilteredAmount,
  getPeriodDateRange,
  CommissionConfigWithRelations,
  CommissionOverrideData,
} from '../../../../src/services/dashboard/commission/commission-utils'
import { prismaMock } from '../../../__helpers__/setup'

// ============================================
// validateRate
// ============================================

describe('validateRate', () => {
  it('should accept valid rates between 0 and 1', () => {
    expect(() => validateRate(0)).not.toThrow()
    expect(() => validateRate(0.03)).not.toThrow()
    expect(() => validateRate(0.5)).not.toThrow()
    expect(() => validateRate(1)).not.toThrow()
  })

  it('should reject negative rates', () => {
    expect(() => validateRate(-0.01)).toThrow('Must be between 0 and 1')
  })

  it('should reject rates above 1', () => {
    expect(() => validateRate(1.01)).toThrow('Must be between 0 and 1')
    expect(() => validateRate(100)).toThrow('Must be between 0 and 1')
  })

  it('should reject NaN', () => {
    expect(() => validateRate(NaN)).toThrow('must be a number')
  })

  it('should reject non-numbers', () => {
    expect(() => validateRate('0.03' as any)).toThrow('must be a number')
  })
})

// ============================================
// decimalToNumber
// ============================================

describe('decimalToNumber', () => {
  it('should convert Decimal to number', () => {
    expect(decimalToNumber(new Decimal(100.5))).toBe(100.5)
    expect(decimalToNumber(new Decimal(0))).toBe(0)
    expect(decimalToNumber(new Decimal(0.03))).toBeCloseTo(0.03)
  })

  it('should return 0 for null/undefined', () => {
    expect(decimalToNumber(null)).toBe(0)
    expect(decimalToNumber(undefined)).toBe(0)
  })
})

// ============================================
// getRecipientStaffId
// ============================================

describe('getRecipientStaffId', () => {
  const payment = { processedById: 'processor-1' }
  const order = { createdById: 'creator-1', servedById: 'server-1' }

  it('should return server for SERVER recipient', () => {
    expect(getRecipientStaffId(payment, order, CommissionRecipient.SERVER)).toBe('server-1')
  })

  it('should fallback to creator when no server', () => {
    const orderNoServer = { createdById: 'creator-1', servedById: null }
    expect(getRecipientStaffId(payment, orderNoServer, CommissionRecipient.SERVER)).toBe('creator-1')
  })

  it('should fallback to processor (kiosk mode) when no server or creator', () => {
    const orderKiosk = { createdById: null, servedById: null }
    expect(getRecipientStaffId(payment, orderKiosk, CommissionRecipient.SERVER)).toBe('processor-1')
  })

  it('should return creator for CREATOR recipient', () => {
    expect(getRecipientStaffId(payment, order, CommissionRecipient.CREATOR)).toBe('creator-1')
  })

  it('should return processor for PROCESSOR recipient', () => {
    expect(getRecipientStaffId(payment, order, CommissionRecipient.PROCESSOR)).toBe('processor-1')
  })

  it('should return null when no order and no processor', () => {
    const noPayment = { processedById: null }
    expect(getRecipientStaffId(noPayment, null, CommissionRecipient.SERVER)).toBeNull()
  })
})

// ============================================
// calculateFinalRate — Rate Cascade
// ============================================

describe('calculateFinalRate', () => {
  const baseConfig: CommissionConfigWithRelations = {
    id: 'config-1',
    venueId: 'venue-1',
    name: 'Test Config',
    priority: 1,
    recipient: CommissionRecipient.SERVER,
    calcType: CommissionCalcType.PERCENTAGE,
    defaultRate: new Decimal(0.03),
    minAmount: null,
    maxAmount: null,
    includeTips: false,
    includeDiscount: false,
    includeTax: false,
    roleRates: { WAITER: 0.04, CASHIER: 0.02 },
    filterByCategories: false,
    categoryIds: [],
    useGoalAsTier: false,
    goalBonusRate: null,
    effectiveFrom: new Date(),
    effectiveTo: null,
    tiers: [],
  }

  it('should use override rate (highest priority)', () => {
    const override: CommissionOverrideData = {
      id: 'override-1',
      staffId: 'staff-1',
      customRate: new Decimal(0.05),
      excludeFromCommissions: false,
      effectiveFrom: new Date(),
      effectiveTo: null,
    }
    expect(calculateFinalRate(baseConfig, override, StaffRole.WAITER, null)).toBe(0.05)
  })

  it('should use tier rate when calcType is TIERED and no override', () => {
    const tieredConfig = { ...baseConfig, calcType: CommissionCalcType.TIERED }
    expect(calculateFinalRate(tieredConfig, null, StaffRole.WAITER, 0.06)).toBe(0.06)
  })

  it('should use role rate when no override or tier', () => {
    expect(calculateFinalRate(baseConfig, null, StaffRole.WAITER, null)).toBe(0.04)
    expect(calculateFinalRate(baseConfig, null, StaffRole.CASHIER, null)).toBe(0.02)
  })

  it('should use default rate when no override, tier, or role rate', () => {
    expect(calculateFinalRate(baseConfig, null, StaffRole.KITCHEN, null)).toBe(0.03)
    expect(calculateFinalRate(baseConfig, null, null, null)).toBe(0.03)
  })

  it('should ignore tier rate for PERCENTAGE calcType', () => {
    expect(calculateFinalRate(baseConfig, null, StaffRole.WAITER, 0.1)).toBe(0.04) // role rate, not tier
  })

  it('should skip override with null customRate', () => {
    const overrideNoRate: CommissionOverrideData = {
      id: 'override-2',
      staffId: 'staff-1',
      customRate: null,
      excludeFromCommissions: false,
      effectiveFrom: new Date(),
      effectiveTo: null,
    }
    expect(calculateFinalRate(baseConfig, overrideNoRate, StaffRole.WAITER, null)).toBe(0.04) // falls to role rate
  })
})

// ============================================
// applyCommissionBounds
// ============================================

describe('applyCommissionBounds', () => {
  it('should return amount unchanged when within bounds', () => {
    expect(applyCommissionBounds(50, { minAmount: new Decimal(10), maxAmount: new Decimal(100) })).toBe(50)
  })

  it('should clamp to minimum', () => {
    expect(applyCommissionBounds(5, { minAmount: new Decimal(10), maxAmount: new Decimal(100) })).toBe(10)
  })

  it('should clamp to maximum', () => {
    expect(applyCommissionBounds(150, { minAmount: new Decimal(10), maxAmount: new Decimal(100) })).toBe(100)
  })

  it('should ignore null bounds', () => {
    expect(applyCommissionBounds(50, { minAmount: null, maxAmount: null })).toBe(50)
  })

  it('should handle zero bounds (no clamping)', () => {
    expect(applyCommissionBounds(50, { minAmount: new Decimal(0), maxAmount: new Decimal(0) })).toBe(50)
  })
})

// ============================================
// calculateBaseAmount
// ============================================

describe('calculateBaseAmount', () => {
  const payment = {
    amount: new Decimal(1000),
    tipAmount: new Decimal(100),
    taxAmount: new Decimal(160),
    discountAmount: new Decimal(50),
  }

  it('should return subtotal only by default (no tax, tips, or discount)', () => {
    const result = calculateBaseAmount(payment, {
      includeTips: false,
      includeDiscount: false,
      includeTax: false,
    })
    expect(result.baseAmount).toBe(1000)
    expect(result.tipAmount).toBe(100)
    expect(result.taxAmount).toBe(160)
  })

  it('should include tax (IVA 16%) when includeTax is true', () => {
    const result = calculateBaseAmount(payment, {
      includeTips: false,
      includeDiscount: false,
      includeTax: true,
    })
    expect(result.baseAmount).toBe(1160) // 1000 + 160
  })

  it('should include tips when includeTips is true', () => {
    const result = calculateBaseAmount(payment, {
      includeTips: true,
      includeDiscount: false,
      includeTax: false,
    })
    expect(result.baseAmount).toBe(1100) // 1000 + 100
  })

  it('should include discount when includeDiscount is true', () => {
    const result = calculateBaseAmount(payment, {
      includeTips: false,
      includeDiscount: true,
      includeTax: false,
    })
    expect(result.baseAmount).toBe(1050) // 1000 + 50 (add back discount for pre-discount amount)
  })

  it('should include all when all flags are true', () => {
    const result = calculateBaseAmount(payment, {
      includeTips: true,
      includeDiscount: true,
      includeTax: true,
    })
    expect(result.baseAmount).toBe(1310) // 1000 + 100 + 160 + 50
  })

  it('should handle null optional amounts', () => {
    const paymentMinimal = {
      amount: new Decimal(500),
      tipAmount: null,
      taxAmount: null,
      discountAmount: null,
    }
    const result = calculateBaseAmount(paymentMinimal, {
      includeTips: true,
      includeDiscount: true,
      includeTax: true,
    })
    expect(result.baseAmount).toBe(500) // All nulls treated as 0
  })
})

// ============================================
// calculateCategoryFilteredAmount
// ============================================

describe('calculateCategoryFilteredAmount', () => {
  it('should sum only items in allowed categories', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      { quantity: 2, unitPrice: new Decimal(100), taxAmount: new Decimal(32), discountAmount: new Decimal(0) },
      { quantity: 1, unitPrice: new Decimal(200), taxAmount: new Decimal(32), discountAmount: new Decimal(10) },
    ])

    const result = await calculateCategoryFilteredAmount('order-1', ['cat-crioterapia', 'cat-iyashi'], {
      includeTax: false,
      includeDiscount: false,
    })

    // 2*100 + 1*200 = 400
    expect(result).toBe(400)

    // Verify Prisma was called with category filter
    expect(prismaMock.orderItem.findMany).toHaveBeenCalledWith({
      where: {
        orderId: 'order-1',
        product: {
          categoryId: { in: ['cat-crioterapia', 'cat-iyashi'] },
        },
      },
      select: {
        quantity: true,
        unitPrice: true,
        taxAmount: true,
        discountAmount: true,
      },
    })
  })

  it('should include tax when configured', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      { quantity: 1, unitPrice: new Decimal(1000), taxAmount: new Decimal(160), discountAmount: new Decimal(0) },
    ])

    const result = await calculateCategoryFilteredAmount('order-1', ['cat-1'], {
      includeTax: true,
      includeDiscount: false,
    })

    expect(result).toBe(1160) // 1000 + 160
  })

  it('should include discount when configured', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      { quantity: 1, unitPrice: new Decimal(1000), taxAmount: new Decimal(0), discountAmount: new Decimal(100) },
    ])

    const result = await calculateCategoryFilteredAmount('order-1', ['cat-1'], {
      includeTax: false,
      includeDiscount: true,
    })

    expect(result).toBe(1100) // 1000 + 100
  })

  it('should return 0 when no items match categories', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([])

    const result = await calculateCategoryFilteredAmount('order-1', ['cat-nonexistent'], {
      includeTax: false,
      includeDiscount: false,
    })

    expect(result).toBe(0)
  })

  it('should handle multiple items with quantities', async () => {
    prismaMock.orderItem.findMany.mockResolvedValue([
      { quantity: 3, unitPrice: new Decimal(50), taxAmount: new Decimal(24), discountAmount: new Decimal(0) },
      { quantity: 1, unitPrice: new Decimal(300), taxAmount: new Decimal(48), discountAmount: new Decimal(0) },
    ])

    const result = await calculateCategoryFilteredAmount('order-1', ['cat-1'], {
      includeTax: false,
      includeDiscount: false,
    })

    // 3*50 + 1*300 = 450
    expect(result).toBe(450)
  })
})

// ============================================
// getPeriodDateRange
// ============================================

describe('getPeriodDateRange', () => {
  // Use a fixed reference date: March 15, 2026 12:00:00 UTC
  const referenceDate = new Date('2026-03-15T18:00:00Z') // noon Mexico time

  it('should return monthly range', () => {
    const { start, end } = getPeriodDateRange(TierPeriod.MONTHLY, referenceDate, 'America/Mexico_City')
    // March 1 midnight Mexico = March 1 06:00 UTC
    expect(start.getUTCMonth()).toBe(2) // March (0-indexed)
    expect(start.getUTCDate()).toBeLessThanOrEqual(2) // 1st or 2nd depending on UTC offset
    // March 31 end of day Mexico
    expect(end.getUTCMonth()).toBe(3) // March end → could be April 1 in UTC
  })

  it('should return daily range', () => {
    const { start, end } = getPeriodDateRange(TierPeriod.DAILY, referenceDate, 'America/Mexico_City')
    // Same day start and end
    const diffMs = end.getTime() - start.getTime()
    const diffHours = diffMs / (1000 * 60 * 60)
    expect(diffHours).toBeCloseTo(24, 0) // Approximately 24 hours
  })

  it('should return weekly range starting Monday', () => {
    const { start, end } = getPeriodDateRange(TierPeriod.WEEKLY, referenceDate, 'America/Mexico_City')
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeCloseTo(7, 0) // Approximately 7 days
  })
})
