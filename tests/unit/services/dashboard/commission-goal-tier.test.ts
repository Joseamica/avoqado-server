/**
 * Commission Goal-Based Tier Tests
 *
 * Tests for resolveGoalBasedTier in commission-tier.service.ts
 * Verifies that staff's monthly sales goal is correctly used as a tier threshold.
 * Also tests STAFF_GOAL boundary resolution in getStaffTierProgress.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { CommissionRecipient, CommissionCalcType } from '@prisma/client'
import { resolveGoalBasedTier, getStaffTierProgress } from '../../../../src/services/dashboard/commission/commission-tier.service'
import { CommissionConfigWithRelations } from '../../../../src/services/dashboard/commission/commission-utils'
import { prismaMock } from '../../../__helpers__/setup'

// Mock sales-goal.service
jest.mock('../../../../src/services/dashboard/commission/sales-goal.service', () => ({
  getStaffSalesGoal: jest.fn(),
}))

// Mock goal-resolution.service
jest.mock('../../../../src/services/dashboard/commission/goal-resolution.service', () => ({
  getEffectiveGoals: jest.fn(),
}))

import { getStaffSalesGoal } from '../../../../src/services/dashboard/commission/sales-goal.service'
import { getEffectiveGoals } from '../../../../src/services/dashboard/commission/goal-resolution.service'

const mockGetStaffSalesGoal = getStaffSalesGoal as jest.MockedFunction<typeof getStaffSalesGoal>
const mockGetEffectiveGoals = getEffectiveGoals as jest.MockedFunction<typeof getEffectiveGoals>

// ============================================
// Test Data
// ============================================

const createGoalConfig = (overrides: Partial<CommissionConfigWithRelations> = {}): CommissionConfigWithRelations => ({
  id: 'config-1',
  venueId: 'venue-1',
  name: 'Goal-Based Config',
  priority: 1,
  recipient: CommissionRecipient.SERVER,
  calcType: CommissionCalcType.TIERED,
  defaultRate: new Decimal(0.04), // 4% base
  minAmount: null,
  maxAmount: null,
  includeTips: false,
  includeDiscount: false,
  includeTax: false,
  roleRates: null,
  filterByCategories: false,
  categoryIds: [],
  useGoalAsTier: true,
  goalBonusRate: new Decimal(0.06), // 6% bonus
  effectiveFrom: new Date(),
  effectiveTo: null,
  tiers: [],
  ...overrides,
})

// Helpers for mock data with all required fields
const mockSalesGoal = (overrides: Record<string, any> = {}) => ({
  id: 'goal-1',
  venueId: 'venue-1',
  staffId: 'staff-1',
  goal: 100000,
  goalType: 'AMOUNT' as const,
  period: 'MONTHLY' as const,
  currentSales: 0,
  active: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
})

const mockResolvedGoal = (overrides: Record<string, any> = {}) => ({
  ...mockSalesGoal({ staffId: null }),
  source: 'venue' as const,
  ...overrides,
})

// ============================================
// Tests
// ============================================

describe('resolveGoalBasedTier', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should return null when useGoalAsTier is false', async () => {
    const config = createGoalConfig({ useGoalAsTier: false })
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 50000)
    expect(result).toBeNull()
  })

  it('should return null when goalBonusRate is null', async () => {
    const config = createGoalConfig({ goalBonusRate: null })
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 50000)
    expect(result).toBeNull()
  })

  // ─── Staff-specific goal ───

  it('should return base rate when staff sales are below their personal goal', async () => {
    mockGetStaffSalesGoal.mockResolvedValue(mockSalesGoal({ goal: 100000 }))

    const config = createGoalConfig()
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 80000) // $80K < $100K goal

    expect(result).toEqual({
      tierLevel: 1,
      tierName: 'Base (bajo meta)',
      rate: 0.04,
    })
  })

  it('should return bonus rate when staff sales exceed their personal goal', async () => {
    mockGetStaffSalesGoal.mockResolvedValue(mockSalesGoal({ goal: 100000 }))

    const config = createGoalConfig()
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 120000) // $120K > $100K

    expect(result).toEqual({
      tierLevel: 2,
      tierName: 'Meta superada',
      rate: 0.06,
    })
  })

  it('should return bonus rate when sales exactly equal the goal', async () => {
    mockGetStaffSalesGoal.mockResolvedValue(mockSalesGoal({ goal: 100000 }))

    const config = createGoalConfig()
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 100000) // Exactly at goal

    expect(result).toEqual({
      tierLevel: 2,
      tierName: 'Meta superada',
      rate: 0.06,
    })
  })

  // ─── Venue-wide goal fallback ───

  it('should fallback to venue-wide goal when no staff-specific goal exists', async () => {
    mockGetStaffSalesGoal.mockResolvedValue(null) // No staff goal
    mockGetEffectiveGoals.mockResolvedValue([mockResolvedGoal({ id: 'venue-goal-1', goal: 80000 })])

    const config = createGoalConfig()
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 90000) // Above venue goal

    expect(result).toEqual({
      tierLevel: 2,
      tierName: 'Meta superada',
      rate: 0.06,
    })
  })

  it('should return base rate when below venue-wide goal', async () => {
    mockGetStaffSalesGoal.mockResolvedValue(null)
    mockGetEffectiveGoals.mockResolvedValue([mockResolvedGoal({ id: 'venue-goal-1', goal: 80000 })])

    const config = createGoalConfig()
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 50000) // Below venue goal

    expect(result).toEqual({
      tierLevel: 1,
      tierName: 'Base (bajo meta)',
      rate: 0.04,
    })
  })

  // ─── No goal at all ───

  it('should return null when no goal exists (staff or venue)', async () => {
    mockGetStaffSalesGoal.mockResolvedValue(null)
    mockGetEffectiveGoals.mockResolvedValue([]) // No goals at all

    const config = createGoalConfig()
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 50000)

    expect(result).toBeNull() // Cascade will use defaultRate
  })

  it('should ignore non-MONTHLY venue goals', async () => {
    mockGetStaffSalesGoal.mockResolvedValue(null)
    mockGetEffectiveGoals.mockResolvedValue([mockResolvedGoal({ id: 'weekly-goal', period: 'WEEKLY', goal: 20000 })])

    const config = createGoalConfig()
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 50000)

    expect(result).toBeNull() // Weekly goal ignored, no monthly goal found
  })

  it('should ignore staff-specific venue goals (only use venue-wide)', async () => {
    mockGetStaffSalesGoal.mockResolvedValue(null)
    mockGetEffectiveGoals.mockResolvedValue([mockResolvedGoal({ id: 'other-staff-goal', staffId: 'other-staff-999', goal: 50000 })])

    const config = createGoalConfig()
    const result = await resolveGoalBasedTier('staff-1', 'venue-1', config, 60000)

    expect(result).toBeNull() // Not a venue-wide goal
  })
})

// ============================================
// getStaffTierProgress — STAFF_GOAL boundaries
// ============================================

describe('getStaffTierProgress — STAFF_GOAL boundaries', () => {
  const tiers = [
    {
      tierLevel: 1,
      tierName: 'Base',
      tierType: 'BY_AMOUNT',
      tierPeriod: 'MONTHLY',
      minThreshold: new Decimal(0),
      maxThreshold: new Decimal(30000),
      minThresholdType: 'FIXED',
      maxThresholdType: 'FIXED',
      rate: new Decimal(0.04),
    },
    {
      tierLevel: 2,
      tierName: 'Meta',
      tierType: 'BY_AMOUNT',
      tierPeriod: 'MONTHLY',
      minThreshold: new Decimal(30000),
      maxThreshold: new Decimal(0),
      minThresholdType: 'FIXED',
      maxThresholdType: 'STAFF_GOAL',
      rate: new Decimal(0.06),
    },
    {
      tierLevel: 3,
      tierName: 'Super',
      tierType: 'BY_AMOUNT',
      tierPeriod: 'MONTHLY',
      minThreshold: new Decimal(0),
      maxThreshold: null,
      minThresholdType: 'STAFF_GOAL',
      maxThresholdType: 'FIXED',
      rate: new Decimal(0.08),
    },
  ]

  beforeEach(() => {
    prismaMock.commissionConfig.findFirst.mockResolvedValue({ id: 'cfg', venueId: 'v', deletedAt: null, tiers })
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  })

  it('puts a staff at 8% when current sales exceed their goal (40k goal, 45k sales)', async () => {
    ;(getStaffSalesGoal as jest.MockedFunction<typeof getStaffSalesGoal>).mockResolvedValue({ goal: 40000 } as any)
    prismaMock.commissionCalculation.aggregate.mockResolvedValue({ _sum: { baseAmount: new Decimal(45000) } })
    const progress = await getStaffTierProgress('cfg', 'staff-1', 'v')
    expect(progress?.currentTier).toBe(3)
  })

  it('puts a staff at 6% when between 30k and their goal (40k goal, 35k sales)', async () => {
    ;(getStaffSalesGoal as jest.MockedFunction<typeof getStaffSalesGoal>).mockResolvedValue({ goal: 40000 } as any)
    prismaMock.commissionCalculation.aggregate.mockResolvedValue({ _sum: { baseAmount: new Decimal(35000) } })
    const progress = await getStaffTierProgress('cfg', 'staff-1', 'v')
    expect(progress?.currentTier).toBe(2)
  })

  it('no goal → stays in 6% band, 8% unreachable (45k sales, no goal)', async () => {
    ;(getStaffSalesGoal as jest.MockedFunction<typeof getStaffSalesGoal>).mockResolvedValue(null)
    prismaMock.commissionCalculation.aggregate.mockResolvedValue({ _sum: { baseAmount: new Decimal(45000) } })
    const progress = await getStaffTierProgress('cfg', 'staff-1', 'v')
    expect(progress?.currentTier).toBe(2)
  })
})
