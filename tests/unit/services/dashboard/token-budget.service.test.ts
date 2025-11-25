import { tokenBudgetService, TokenQueryType } from '../../../../src/services/dashboard/token-budget.service'
import { prismaMock } from '../../../__helpers__/setup'
import { TokenPurchaseStatus } from '@prisma/client'

// Token config constants (matching the service)
const TOKEN_CONFIG = {
  DEFAULT_MONTHLY_FREE_TOKENS: 10000,
  PRICE_PER_1K_TOKENS_USD: 0.03, // Price we charge customers
  OPENAI_COST_PER_1K_TOKENS_USD: 0.01, // Actual OpenAI cost (used for estimatedCost)
  FREE_TOKENS_PER_MONTH: 10000,
  DEFAULT_AUTO_RECHARGE_THRESHOLD: 1000,
  DEFAULT_AUTO_RECHARGE_AMOUNT: 10000,
}

// Helper to create mock budget with future dates
const createMockBudget = (overrides: Record<string, any> = {}) => ({
  id: 'budget-123',
  venueId: 'venue-123',
  monthlyFreeTokens: 10000,
  currentMonthUsed: 0,
  extraTokensBalance: 0,
  overageTokensUsed: 0,
  totalTokensUsed: BigInt(0),
  totalTokensPurchased: BigInt(0),
  totalAmountSpent: 0,
  currentPeriodStart: new Date('2025-11-01'),
  currentPeriodEnd: new Date('2025-12-31'), // Future date to prevent reset
  autoRechargeEnabled: false,
  autoRechargeThreshold: 1000,
  autoRechargeAmount: 10000,
  overageWarningShown: false,
  ...overrides,
})

// Mock the logger
jest.mock('../../../../src/config/logger')

// Mock Stripe
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: jest.fn().mockResolvedValue({
        id: 'pi_test_123',
        status: 'requires_confirmation',
        client_secret: 'pi_test_123_secret',
      }),
    },
  }))
})

describe('TokenBudgetService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('getOrCreateBudget', () => {
    it('should return existing budget when found', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 2500,
        extraTokensBalance: 5000,
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)

      const result = await tokenBudgetService.getOrCreateBudget('venue-123')

      expect(result).toEqual(mockBudget)
      expect(prismaMock.chatbotTokenBudget.findUnique).toHaveBeenCalledWith({
        where: { venueId: 'venue-123' },
      })
    })

    it('should create new budget when not found', async () => {
      const mockNewBudget = createMockBudget({
        id: 'budget-new',
        venueId: 'venue-456',
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(null)
      prismaMock.chatbotTokenBudget.create.mockResolvedValue(mockNewBudget as any)

      const result = await tokenBudgetService.getOrCreateBudget('venue-456')

      expect(result.venueId).toBe('venue-456')
      expect(prismaMock.chatbotTokenBudget.create).toHaveBeenCalled()
    })
  })

  describe('getBudgetStatus', () => {
    it('should calculate correct status with available tokens', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 3000,
        extraTokensBalance: 5000,
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)

      const status = await tokenBudgetService.getBudgetStatus('venue-123')

      expect(status.freeTokensRemaining).toBe(7000) // 10000 - 3000
      expect(status.extraTokensBalance).toBe(5000)
      expect(status.totalAvailable).toBe(12000) // 7000 + 5000
      expect(status.percentageUsed).toBe(30) // 3000 / 10000 * 100
      expect(status.isInOverage).toBe(false)
      expect(status.warning).toBeUndefined()
    })

    it('should show warning when budget is low (80%+)', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 8500,
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)

      const status = await tokenBudgetService.getBudgetStatus('venue-123')

      expect(status.percentageUsed).toBe(85)
      expect(status.warning).toContain('15%')
    })

    it('should detect overage status', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 10000,
        overageTokensUsed: 2000,
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)

      const status = await tokenBudgetService.getBudgetStatus('venue-123')

      expect(status.isInOverage).toBe(true)
      expect(status.overageTokensUsed).toBe(2000)
      expect(status.overageCost).toBe(0.06) // (2000/1000) * 0.03 = 0.06
    })
  })

  describe('checkTokensAvailable', () => {
    it('should allow query when tokens available', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 3000,
        extraTokensBalance: 5000,
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)

      const result = await tokenBudgetService.checkTokensAvailable('venue-123', 5000)

      expect(result.allowed).toBe(true)
      expect(result.warning).toBeUndefined()
    })

    it('should allow with warning when going into overage (soft limit)', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 9000,
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)

      const result = await tokenBudgetService.checkTokensAvailable('venue-123', 5000)

      // Soft limit - should ALWAYS allow
      expect(result.allowed).toBe(true)
      expect(result.warning).toBeDefined()
      expect(result.warning).toContain('excederá') // "excederá tu límite"
    })
  })

  describe('recordTokenUsage', () => {
    it('should deduct from free tokens first', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 5000,
        extraTokensBalance: 3000,
        totalTokensUsed: BigInt(50000),
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)
      prismaMock.chatbotTokenBudget.update.mockResolvedValue(mockBudget as any)
      prismaMock.tokenUsageRecord.create.mockResolvedValue({} as any)

      await tokenBudgetService.recordTokenUsage({
        venueId: 'venue-123',
        userId: 'user-123',
        promptTokens: 2000,
        completionTokens: 1000,
        queryType: TokenQueryType.COMPLEX_SINGLE,
      })

      // Should update budget with increment/decrement operations
      // 3000 tokens total, all from free (5000 + 3000 = 8000 still under 10000)
      expect(prismaMock.chatbotTokenBudget.update).toHaveBeenCalledWith({
        where: { id: 'budget-123' },
        data: expect.objectContaining({
          currentMonthUsed: { increment: 3000 }, // all from free
          extraTokensBalance: { decrement: 0 }, // none from extra
          overageTokensUsed: { increment: 0 }, // no overage
          totalTokensUsed: { increment: 3000 },
        }),
      })
    })

    it('should use extra tokens when free exhausted', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 9500,
        extraTokensBalance: 5000,
        totalTokensUsed: BigInt(50000),
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)
      prismaMock.chatbotTokenBudget.update.mockResolvedValue(mockBudget as any)
      prismaMock.tokenUsageRecord.create.mockResolvedValue({} as any)

      await tokenBudgetService.recordTokenUsage({
        venueId: 'venue-123',
        userId: 'user-123',
        promptTokens: 700,
        completionTokens: 300,
        queryType: TokenQueryType.COMPLEX_SINGLE,
      })

      // 1000 tokens total: 500 from free (10000 - 9500), 500 from extra
      expect(prismaMock.chatbotTokenBudget.update).toHaveBeenCalledWith({
        where: { id: 'budget-123' },
        data: expect.objectContaining({
          currentMonthUsed: { increment: 500 }, // only 500 left in free
          extraTokensBalance: { decrement: 500 }, // 500 from extra
          overageTokensUsed: { increment: 0 }, // no overage
          totalTokensUsed: { increment: 1000 },
        }),
      })
    })

    it('should track overage when all tokens exhausted', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 10000,
        totalTokensUsed: BigInt(50000),
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)
      prismaMock.chatbotTokenBudget.update.mockResolvedValue(mockBudget as any)
      prismaMock.tokenUsageRecord.create.mockResolvedValue({} as any)

      await tokenBudgetService.recordTokenUsage({
        venueId: 'venue-123',
        userId: 'user-123',
        promptTokens: 1500,
        completionTokens: 500,
        queryType: TokenQueryType.COMPLEX_CONSENSUS,
      })

      // All 2000 tokens should go to overage
      expect(prismaMock.chatbotTokenBudget.update).toHaveBeenCalledWith({
        where: { id: 'budget-123' },
        data: expect.objectContaining({
          currentMonthUsed: { increment: 0 }, // none from free
          extraTokensBalance: { decrement: 0 }, // none from extra
          overageTokensUsed: { increment: 2000 }, // all to overage
          totalTokensUsed: { increment: 2000 },
        }),
      })
    })

    it('should create usage record with correct data', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 5000,
        totalTokensUsed: BigInt(50000),
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)
      prismaMock.chatbotTokenBudget.update.mockResolvedValue(mockBudget as any)
      prismaMock.tokenUsageRecord.create.mockResolvedValue({} as any)

      await tokenBudgetService.recordTokenUsage({
        venueId: 'venue-123',
        userId: 'user-456',
        promptTokens: 2000,
        completionTokens: 1000,
        queryType: TokenQueryType.RESULT_INTERPRETATION,
        trainingDataId: 'training-123',
      })

      expect(prismaMock.tokenUsageRecord.create).toHaveBeenCalledWith({
        data: {
          budgetId: 'budget-123',
          userId: 'user-456',
          promptTokens: 2000,
          completionTokens: 1000,
          totalTokens: 3000,
          queryType: TokenQueryType.RESULT_INTERPRETATION,
          trainingDataId: 'training-123',
          estimatedCost: 0.03, // (3000/1000) * OPENAI_COST_PER_1K_TOKENS_USD (0.01)
        },
      })
    })
  })

  describe('completePurchase', () => {
    it('should return false if purchase not found', async () => {
      prismaMock.tokenPurchase.findUnique.mockResolvedValue(null)

      const result = await tokenBudgetService.completePurchase('pi_nonexistent')

      expect(result).toBe(false)
      expect(prismaMock.tokenPurchase.findUnique).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: 'pi_nonexistent' },
        include: { budget: true },
      })
    })

    it('should return true if purchase already completed', async () => {
      const mockPurchase = {
        id: 'purchase-123',
        budgetId: 'budget-123',
        tokenAmount: 50000,
        status: TokenPurchaseStatus.COMPLETED,
        budget: { id: 'budget-123' },
      }

      prismaMock.tokenPurchase.findUnique.mockResolvedValue(mockPurchase as any)

      const result = await tokenBudgetService.completePurchase('pi_test_123')

      expect(result).toBe(true)
    })
  })

  describe('failPurchase', () => {
    it('should mark purchase as failed using updateMany', async () => {
      prismaMock.tokenPurchase.updateMany.mockResolvedValue({ count: 1 })

      const result = await tokenBudgetService.failPurchase('pi_failed_123')

      expect(result).toBe(true)
      expect(prismaMock.tokenPurchase.updateMany).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: 'pi_failed_123' },
        data: { status: TokenPurchaseStatus.FAILED },
      })
    })
  })

  describe('resetMonthlyBudget', () => {
    it('should reset monthly counters and keep extra balance', async () => {
      const mockBudget = createMockBudget({
        currentMonthUsed: 8500,
        overageTokensUsed: 1500,
        extraTokensBalance: 3000,
        overageWarningShown: true,
      })

      prismaMock.chatbotTokenBudget.findUnique.mockResolvedValue(mockBudget as any)
      prismaMock.chatbotTokenBudget.update.mockResolvedValue({} as any)

      await tokenBudgetService.resetMonthlyBudget('venue-123')

      expect(prismaMock.chatbotTokenBudget.update).toHaveBeenCalledWith({
        where: { id: 'budget-123' },
        data: {
          currentMonthUsed: 0,
          overageTokensUsed: 0,
          overageWarningShown: false,
          currentPeriodStart: expect.any(Date),
          currentPeriodEnd: expect.any(Date),
        },
      })
    })
  })

  describe('TOKEN_CONFIG', () => {
    it('should have correct configuration values', () => {
      expect(TOKEN_CONFIG.FREE_TOKENS_PER_MONTH).toBe(10000)
      expect(TOKEN_CONFIG.PRICE_PER_1K_TOKENS_USD).toBe(0.03) // Price charged to customers
      expect(TOKEN_CONFIG.OPENAI_COST_PER_1K_TOKENS_USD).toBe(0.01) // Actual OpenAI cost
      expect(TOKEN_CONFIG.DEFAULT_AUTO_RECHARGE_THRESHOLD).toBe(1000)
      expect(TOKEN_CONFIG.DEFAULT_AUTO_RECHARGE_AMOUNT).toBe(10000)
    })
  })
})
