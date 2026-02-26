/**
 * Token Budget Service
 *
 * Manages chatbot token budgets per venue with:
 * - 1,000,000 free tokens/month for subscribers ($600 MXN worth)
 * - Soft limit with overage tracking (never blocks)
 * - Auto-recharge via Stripe
 * - Manual token purchases
 *
 * Pricing: $0.03 USD / $0.60 MXN per 1,000 tokens (200% margin over OpenAI cost)
 *
 * @see docs/TOKEN_BUDGET_SYSTEM.md for full documentation
 */

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { TokenQueryType, TokenPurchaseType, TokenPurchaseStatus } from '@prisma/client'
import Stripe from 'stripe'
import { logAction } from './activity-log.service'

// Re-export enum for convenience
export { TokenQueryType }

// ==========================================
// CONFIGURATION
// ==========================================

const CONFIG = {
  // Free tier for subscribers
  // Subscription: $400 MXN/month includes $600 MXN worth of tokens
  // $600 MXN ÷ $0.60 MXN per 1K tokens = 1,000,000 tokens (1M)
  DEFAULT_MONTHLY_FREE_TOKENS: 1000000,

  // Pricing (in USD)
  PRICE_PER_1K_TOKENS_USD: 0.03, // $0.03 per 1,000 tokens
  OPENAI_COST_PER_1K_TOKENS_USD: 0.01, // Actual OpenAI cost (for margin calculation)

  // Auto-recharge defaults
  DEFAULT_AUTO_RECHARGE_THRESHOLD: 5000,
  DEFAULT_AUTO_RECHARGE_AMOUNT: 20000, // Minimum to meet Stripe's charge requirement

  // Token packages (for Stripe products)
  // Minimum $0.60 USD to meet Stripe's minimum charge (~$0.50 USD / 10 MXN)
  TOKEN_PACKAGES: [
    { tokens: 20000, priceUsd: 0.6, priceMxn: 10.2, name: 'Small' },
    { tokens: 50000, priceUsd: 1.5, priceMxn: 25.5, name: 'Medium' },
    { tokens: 100000, priceUsd: 3.0, priceMxn: 51.0, name: 'Large' },
  ],
}

// ==========================================
// INTERFACES
// ==========================================

export interface TokenBudgetStatus {
  // Current period info
  monthlyFreeTokens: number
  currentMonthUsed: number
  extraTokensBalance: number
  overageTokensUsed: number
  periodStart: Date
  periodEnd: Date

  // Calculated values
  freeTokensRemaining: number
  totalAvailable: number // free remaining + extra balance
  isInOverage: boolean
  percentageUsed: number // percentage of free tokens used (0-100+)
  overageCost: number // cost of overage tokens in USD

  // Auto-recharge settings
  autoRechargeEnabled: boolean
  autoRechargeThreshold: number
  autoRechargeAmount: number

  // Lifetime stats (converted from BigInt for JSON serialization)
  totalTokensUsed: number
  totalTokensPurchased: number
  totalAmountSpent: number

  // Warning message (if in overage or low)
  warning?: string
}

export interface TokenCheckResult {
  allowed: boolean // Always true (soft limit)
  status: TokenBudgetStatus
  warning?: string // Warning if in/entering overage
  shouldTriggerAutoRecharge: boolean
}

export interface RecordTokenUsageParams {
  venueId: string
  userId: string
  promptTokens: number
  completionTokens: number
  queryType: TokenQueryType
  trainingDataId?: string
}

export interface PurchaseTokensParams {
  venueId: string
  tokenAmount: number
  userId: string
  stripePaymentIntentId?: string
  stripeInvoiceId?: string
  purchaseType?: TokenPurchaseType
  /** Amount paid in venue's local currency (e.g., 30.00 for 30 MXN). If not provided, calculates in USD (legacy) */
  amountPaid?: number
  /** Currency code (e.g., 'MXN', 'USD'). Defaults to 'MXN' */
  currency?: string
}

// ==========================================
// SERVICE
// ==========================================

class TokenBudgetService {
  private stripe: Stripe | null = null

  constructor() {
    if (process.env.STRIPE_SECRET_KEY) {
      // Using default API version from SDK (automatically uses the latest compatible version)
      this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
    }
  }

  // ==========================================
  // BUDGET MANAGEMENT
  // ==========================================

  /**
   * Get or create token budget for a venue
   * Creates a new budget with default settings if none exists
   */
  async getOrCreateBudget(venueId: string) {
    let budget = await prisma.chatbotTokenBudget.findUnique({
      where: { venueId },
    })

    if (!budget) {
      // Calculate end of current month
      const now = new Date()
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1) // First day of next month

      budget = await prisma.chatbotTokenBudget.create({
        data: {
          venueId,
          monthlyFreeTokens: CONFIG.DEFAULT_MONTHLY_FREE_TOKENS,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          autoRechargeThreshold: CONFIG.DEFAULT_AUTO_RECHARGE_THRESHOLD,
          autoRechargeAmount: CONFIG.DEFAULT_AUTO_RECHARGE_AMOUNT,
        },
      })

      logger.info('Created new token budget for venue', {
        venueId,
        monthlyFreeTokens: budget.monthlyFreeTokens,
        periodEnd: budget.currentPeriodEnd,
      })
    }

    // Check if we need to reset for new billing period
    if (new Date() >= budget.currentPeriodEnd) {
      budget = await this.resetMonthlyBudget(venueId)
    }

    return budget
  }

  /**
   * Get current budget status for display
   */
  async getBudgetStatus(venueId: string): Promise<TokenBudgetStatus> {
    const budget = await this.getOrCreateBudget(venueId)

    const freeTokensRemaining = Math.max(0, budget.monthlyFreeTokens - budget.currentMonthUsed)
    const totalAvailable = freeTokensRemaining + budget.extraTokensBalance
    const isInOverage = budget.overageTokensUsed > 0
    const percentageUsed = Math.round((budget.currentMonthUsed / budget.monthlyFreeTokens) * 100)
    const overageCost = (budget.overageTokensUsed / 1000) * CONFIG.PRICE_PER_1K_TOKENS_USD

    let warning: string | undefined

    if (isInOverage) {
      warning = `Has usado ${budget.overageTokensUsed.toLocaleString()} tokens de más. Se cobrarán $${overageCost.toFixed(2)} USD al final del mes.`
    } else if (percentageUsed >= 80) {
      const remaining = 100 - percentageUsed
      warning = `Has usado el ${percentageUsed}% de tus tokens gratuitos. Te queda ${remaining}% del mes.`
    } else if (totalAvailable < 2000) {
      warning = `Te quedan pocos tokens (${totalAvailable.toLocaleString()}). Considera comprar más o activar auto-recarga.`
    }

    return {
      monthlyFreeTokens: budget.monthlyFreeTokens,
      currentMonthUsed: budget.currentMonthUsed,
      extraTokensBalance: budget.extraTokensBalance,
      overageTokensUsed: budget.overageTokensUsed,
      periodStart: budget.currentPeriodStart,
      periodEnd: budget.currentPeriodEnd,
      freeTokensRemaining,
      totalAvailable,
      isInOverage,
      percentageUsed,
      overageCost,
      autoRechargeEnabled: budget.autoRechargeEnabled,
      autoRechargeThreshold: budget.autoRechargeThreshold,
      autoRechargeAmount: budget.autoRechargeAmount,
      // Convert BigInt to Number for JSON serialization
      totalTokensUsed: Number(budget.totalTokensUsed),
      totalTokensPurchased: Number(budget.totalTokensPurchased),
      totalAmountSpent: Number(budget.totalAmountSpent),
      warning,
    }
  }

  /**
   * Check if tokens are available (soft limit - always returns allowed: true)
   * Returns warning if entering/in overage
   */
  async checkTokensAvailable(venueId: string, estimatedTokens: number = 5000): Promise<TokenCheckResult> {
    const status = await this.getBudgetStatus(venueId)

    let warning: string | undefined
    const willEnterOverage = estimatedTokens > status.totalAvailable

    if (willEnterOverage && !status.isInOverage) {
      const estimatedOverage = estimatedTokens - status.totalAvailable
      const overageCost = (estimatedOverage / 1000) * CONFIG.PRICE_PER_1K_TOKENS_USD
      warning = `Esta consulta usará ~${estimatedTokens.toLocaleString()} tokens y excederá tu límite. Se cobrarán aproximadamente $${overageCost.toFixed(2)} USD.`
    } else if (status.isInOverage) {
      warning = status.warning
    }

    // Check if auto-recharge should be triggered
    const shouldTriggerAutoRecharge =
      status.autoRechargeEnabled && status.totalAvailable < status.autoRechargeThreshold && !status.isInOverage

    return {
      allowed: true, // SOFT LIMIT - Always allow
      status,
      warning,
      shouldTriggerAutoRecharge,
    }
  }

  // ==========================================
  // TOKEN USAGE TRACKING
  // ==========================================

  /**
   * Record token usage after an OpenAI API call
   * This is the main method called from text-to-sql-assistant.service.ts
   */
  async recordTokenUsage(params: RecordTokenUsageParams): Promise<{
    status: TokenBudgetStatus
    warning?: string
    autoRechargeTriggered: boolean
  }> {
    const { venueId, userId, promptTokens, completionTokens, queryType, trainingDataId } = params
    const totalTokens = promptTokens + completionTokens

    // Skip recording for simple queries (0 tokens)
    if (queryType === TokenQueryType.SIMPLE_QUERY || totalTokens === 0) {
      const status = await this.getBudgetStatus(venueId)
      return { status, autoRechargeTriggered: false }
    }

    const budget = await this.getOrCreateBudget(venueId)
    const estimatedCost = (totalTokens / 1000) * CONFIG.OPENAI_COST_PER_1K_TOKENS_USD

    // Calculate token deduction
    const freeRemaining = Math.max(0, budget.monthlyFreeTokens - budget.currentMonthUsed)
    const fromFree = Math.min(totalTokens, freeRemaining)
    const fromExtra = Math.min(totalTokens - fromFree, budget.extraTokensBalance)
    const toOverage = totalTokens - fromFree - fromExtra

    // Update budget
    const updatedBudget = await prisma.chatbotTokenBudget.update({
      where: { id: budget.id },
      data: {
        currentMonthUsed: { increment: fromFree },
        extraTokensBalance: { decrement: fromExtra },
        overageTokensUsed: { increment: toOverage },
        totalTokensUsed: { increment: totalTokens },
        overageWarningShown: toOverage > 0 ? true : budget.overageWarningShown,
      },
    })

    // Record usage
    await prisma.tokenUsageRecord.create({
      data: {
        budgetId: budget.id,
        userId,
        promptTokens,
        completionTokens,
        totalTokens,
        queryType,
        trainingDataId,
        estimatedCost,
      },
    })

    logger.info('Recorded token usage', {
      venueId,
      userId,
      totalTokens,
      queryType,
      fromFree,
      fromExtra,
      toOverage,
      estimatedCost,
    })

    // Get updated status
    const status = await this.getBudgetStatus(venueId)

    // Check if auto-recharge should be triggered
    let autoRechargeTriggered = false
    if (updatedBudget.autoRechargeEnabled && status.totalAvailable < updatedBudget.autoRechargeThreshold && !status.isInOverage) {
      autoRechargeTriggered = await this.triggerAutoRecharge(venueId)
    }

    return {
      status,
      warning: status.warning,
      autoRechargeTriggered,
    }
  }

  // ==========================================
  // TOKEN PURCHASES
  // ==========================================

  /**
   * Purchase tokens manually or via auto-recharge
   */
  async purchaseTokens(params: PurchaseTokensParams): Promise<{
    success: boolean
    purchase?: { id: string; tokenAmount: number; amountPaid: number; currency: string }
    error?: string
  }> {
    const {
      venueId,
      tokenAmount,
      userId,
      stripePaymentIntentId,
      stripeInvoiceId,
      purchaseType = TokenPurchaseType.MANUAL,
      amountPaid: providedAmount,
      currency = 'MXN',
    } = params

    const budget = await this.getOrCreateBudget(venueId)
    // Use provided amount (in local currency) or fallback to USD calculation (legacy)
    const amountPaid = providedAmount ?? (tokenAmount / 1000) * CONFIG.PRICE_PER_1K_TOKENS_USD

    // Determine if we have a Stripe payment (either PaymentIntent or Invoice)
    const hasStripePayment = !!(stripePaymentIntentId || stripeInvoiceId)

    try {
      // Create purchase record
      const purchase = await prisma.tokenPurchase.create({
        data: {
          budgetId: budget.id,
          tokenAmount,
          amountPaid,
          stripePaymentIntentId,
          stripeInvoiceId,
          purchaseType,
          triggeredBy: userId,
          status: hasStripePayment ? TokenPurchaseStatus.PENDING : TokenPurchaseStatus.COMPLETED,
          completedAt: hasStripePayment ? null : new Date(),
        },
      })

      // If no Stripe payment (promotional or testing), add tokens immediately
      if (!hasStripePayment) {
        await prisma.chatbotTokenBudget.update({
          where: { id: budget.id },
          data: {
            extraTokensBalance: { increment: tokenAmount },
            totalTokensPurchased: { increment: tokenAmount },
            totalAmountSpent: { increment: amountPaid },
          },
        })
      }

      logger.info('Token purchase created', {
        venueId,
        tokenAmount,
        amountPaid,
        currency,
        purchaseType,
        status: purchase.status,
        stripeInvoiceId,
        stripePaymentIntentId,
      })

      if (purchaseType === TokenPurchaseType.MANUAL) {
        logAction({
          staffId: userId,
          venueId,
          action: 'TOKENS_PURCHASED',
          entity: 'TokenPurchase',
          entityId: purchase.id,
          data: { tokenAmount, amountPaid, currency },
        })
      }

      return {
        success: true,
        purchase: {
          id: purchase.id,
          tokenAmount: purchase.tokenAmount,
          amountPaid: Number(purchase.amountPaid),
          currency,
        },
      }
    } catch (error) {
      logger.error('Failed to create token purchase', { venueId, tokenAmount, error })
      return {
        success: false,
        error: 'Failed to create token purchase',
      }
    }
  }

  /**
   * Complete a pending purchase (called from Stripe webhook)
   */
  async completePurchase(stripePaymentIntentId: string): Promise<boolean> {
    try {
      const purchase = await prisma.tokenPurchase.findUnique({
        where: { stripePaymentIntentId },
        include: { budget: true },
      })

      if (!purchase) {
        logger.warn('Token purchase not found for payment intent', { stripePaymentIntentId })
        return false
      }

      if (purchase.status === TokenPurchaseStatus.COMPLETED) {
        logger.info('Token purchase already completed', { stripePaymentIntentId })
        return true
      }

      // Fetch receipt URL from Stripe
      let stripeReceiptUrl: string | null = null
      try {
        const stripe = new (await import('stripe')).default(process.env.STRIPE_SECRET_KEY!)
        const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId, {
          expand: ['latest_charge'],
        })

        // Get receipt URL from the charge
        if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'object') {
          stripeReceiptUrl = paymentIntent.latest_charge.receipt_url || null
        }
      } catch (stripeError) {
        logger.warn('Failed to fetch receipt URL from Stripe', { stripePaymentIntentId, error: stripeError })
        // Continue without receipt URL - not critical
      }

      // Update purchase and add tokens
      await prisma.$transaction([
        prisma.tokenPurchase.update({
          where: { id: purchase.id },
          data: {
            status: TokenPurchaseStatus.COMPLETED,
            completedAt: new Date(),
            stripeReceiptUrl,
          },
        }),
        prisma.chatbotTokenBudget.update({
          where: { id: purchase.budgetId },
          data: {
            extraTokensBalance: { increment: purchase.tokenAmount },
            totalTokensPurchased: { increment: purchase.tokenAmount },
            totalAmountSpent: { increment: purchase.amountPaid },
          },
        }),
      ])

      logger.info('Token purchase completed', {
        purchaseId: purchase.id,
        tokenAmount: purchase.tokenAmount,
        stripePaymentIntentId,
        hasReceiptUrl: !!stripeReceiptUrl,
      })

      return true
    } catch (error) {
      logger.error('Failed to complete token purchase', { stripePaymentIntentId, error })
      return false
    }
  }

  /**
   * Mark a purchase as failed (called from Stripe webhook)
   */
  async failPurchase(stripePaymentIntentId: string): Promise<boolean> {
    try {
      await prisma.tokenPurchase.updateMany({
        where: { stripePaymentIntentId },
        data: { status: TokenPurchaseStatus.FAILED },
      })

      logger.warn('Token purchase failed', { stripePaymentIntentId })
      return true
    } catch (error) {
      logger.error('Failed to mark token purchase as failed', { stripePaymentIntentId, error })
      return false
    }
  }

  /**
   * Complete an invoice-based purchase (called after Stripe invoice is paid)
   * This method handles token purchases made via Stripe Invoices (with PDF receipt)
   */
  async completeInvoicePurchase(
    stripeInvoiceId: string,
    options?: { invoicePdfUrl?: string; hostedInvoiceUrl?: string },
  ): Promise<boolean> {
    try {
      const purchase = await prisma.tokenPurchase.findFirst({
        where: { stripeInvoiceId },
        include: { budget: true },
      })

      if (!purchase) {
        logger.warn('Token purchase not found for invoice', { stripeInvoiceId })
        return false
      }

      if (purchase.status === TokenPurchaseStatus.COMPLETED) {
        logger.info('Token purchase already completed', { stripeInvoiceId })
        return true
      }

      // Update purchase and add tokens
      await prisma.$transaction([
        prisma.tokenPurchase.update({
          where: { id: purchase.id },
          data: {
            status: TokenPurchaseStatus.COMPLETED,
            completedAt: new Date(),
            // Store hosted invoice URL for viewing receipt online
            stripeReceiptUrl: options?.hostedInvoiceUrl || null,
            // Store PDF URL for downloading invoice
            stripeInvoicePdfUrl: options?.invoicePdfUrl || null,
          },
        }),
        prisma.chatbotTokenBudget.update({
          where: { id: purchase.budgetId },
          data: {
            extraTokensBalance: { increment: purchase.tokenAmount },
            totalTokensPurchased: { increment: purchase.tokenAmount },
            totalAmountSpent: { increment: purchase.amountPaid },
          },
        }),
      ])

      logger.info('Token purchase completed via invoice', {
        purchaseId: purchase.id,
        tokenAmount: purchase.tokenAmount,
        stripeInvoiceId,
        hasInvoicePdf: !!options?.invoicePdfUrl,
        hasHostedUrl: !!options?.hostedInvoiceUrl,
      })

      return true
    } catch (error) {
      logger.error('Failed to complete invoice token purchase', { stripeInvoiceId, error })
      return false
    }
  }

  /**
   * Mark an invoice-based purchase as failed
   */
  async failInvoicePurchase(stripeInvoiceId: string): Promise<boolean> {
    try {
      await prisma.tokenPurchase.updateMany({
        where: { stripeInvoiceId },
        data: { status: TokenPurchaseStatus.FAILED },
      })

      logger.warn('Invoice token purchase failed', { stripeInvoiceId })
      return true
    } catch (error) {
      logger.error('Failed to mark invoice token purchase as failed', { stripeInvoiceId, error })
      return false
    }
  }

  // ==========================================
  // AUTO-RECHARGE
  // ==========================================

  /**
   * Trigger auto-recharge when tokens are low
   */
  async triggerAutoRecharge(venueId: string): Promise<boolean> {
    const budget = await this.getOrCreateBudget(venueId)

    if (!budget.autoRechargeEnabled) {
      return false
    }

    // Get venue's Stripe customer ID
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { stripeCustomerId: true, stripePaymentMethodId: true },
    })

    if (!venue?.stripeCustomerId || !venue?.stripePaymentMethodId) {
      logger.warn('Cannot auto-recharge: venue missing Stripe setup', { venueId })
      return false
    }

    if (!this.stripe) {
      logger.error('Stripe not configured for auto-recharge')
      return false
    }

    try {
      const amount = Math.round((budget.autoRechargeAmount / 1000) * CONFIG.PRICE_PER_1K_TOKENS_USD * 100) // Convert to cents

      // Create payment intent
      const paymentIntent = await this.stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: venue.stripeCustomerId,
        payment_method: venue.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        metadata: {
          type: 'chatbot_tokens_auto_recharge',
          venueId,
          tokenAmount: String(budget.autoRechargeAmount),
        },
      })

      // Record the purchase (will be completed via webhook)
      await this.purchaseTokens({
        venueId,
        tokenAmount: budget.autoRechargeAmount,
        userId: 'auto-recharge',
        stripePaymentIntentId: paymentIntent.id,
        purchaseType: TokenPurchaseType.AUTO_RECHARGE,
      })

      logger.info('Auto-recharge triggered', {
        venueId,
        tokenAmount: budget.autoRechargeAmount,
        paymentIntentId: paymentIntent.id,
      })

      return true
    } catch (error) {
      logger.error('Auto-recharge failed', { venueId, error })
      return false
    }
  }

  /**
   * Update auto-recharge settings
   */
  async updateAutoRechargeSettings(
    venueId: string,
    settings: {
      enabled?: boolean
      threshold?: number
      amount?: number
    },
  ): Promise<TokenBudgetStatus> {
    const budget = await this.getOrCreateBudget(venueId)

    await prisma.chatbotTokenBudget.update({
      where: { id: budget.id },
      data: {
        autoRechargeEnabled: settings.enabled ?? budget.autoRechargeEnabled,
        autoRechargeThreshold: settings.threshold ?? budget.autoRechargeThreshold,
        autoRechargeAmount: settings.amount ?? budget.autoRechargeAmount,
      },
    })

    logAction({
      venueId,
      action: 'AUTO_RECHARGE_SETTINGS_UPDATED',
      entity: 'ChatbotTokenBudget',
      entityId: budget.id,
      data: { changes: settings },
    })

    return this.getBudgetStatus(venueId)
  }

  // ==========================================
  // BILLING PERIOD MANAGEMENT
  // ==========================================

  /**
   * Reset monthly budget (called automatically or via cron)
   */
  async resetMonthlyBudget(venueId: string) {
    const budget = await prisma.chatbotTokenBudget.findUnique({
      where: { venueId },
    })

    if (!budget) {
      throw new Error(`Budget not found for venue ${venueId}`)
    }

    // Calculate new period
    const now = new Date()
    const newPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

    // If there's overage, it should be billed before reset
    if (budget.overageTokensUsed > 0) {
      logger.info('Overage detected at period reset', {
        venueId,
        overageTokens: budget.overageTokensUsed,
        overageCost: (budget.overageTokensUsed / 1000) * CONFIG.PRICE_PER_1K_TOKENS_USD,
      })
      // TODO: Create overage invoice via Stripe
    }

    const updatedBudget = await prisma.chatbotTokenBudget.update({
      where: { id: budget.id },
      data: {
        currentMonthUsed: 0,
        overageTokensUsed: 0,
        overageWarningShown: false,
        currentPeriodStart: now,
        currentPeriodEnd: newPeriodEnd,
      },
    })

    logger.info('Monthly budget reset', {
      venueId,
      newPeriodStart: now,
      newPeriodEnd,
    })

    return updatedBudget
  }

  // ==========================================
  // ANALYTICS
  // ==========================================

  /**
   * Get usage analytics for a venue
   */
  async getUsageAnalytics(
    venueId: string,
    options?: {
      startDate?: Date
      endDate?: Date
      groupBy?: 'day' | 'week' | 'month'
    },
  ) {
    const budget = await this.getOrCreateBudget(venueId)
    const startDate = options?.startDate || budget.currentPeriodStart
    const endDate = options?.endDate || new Date()

    // Get usage records
    const records = await prisma.tokenUsageRecord.findMany({
      where: {
        budgetId: budget.id,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    // Aggregate by query type
    const byQueryType = records.reduce(
      (acc, r) => {
        if (!acc[r.queryType]) {
          acc[r.queryType] = { count: 0, tokens: 0 }
        }
        acc[r.queryType].count++
        acc[r.queryType].tokens += r.totalTokens
        return acc
      },
      {} as Record<string, { count: number; tokens: number }>,
    )

    // Calculate totals
    const totalQueries = records.length
    const totalTokens = records.reduce((sum, r) => sum + r.totalTokens, 0)
    const totalCost = records.reduce((sum, r) => sum + Number(r.estimatedCost), 0)

    return {
      period: { start: startDate, end: endDate },
      totalQueries,
      totalTokens,
      totalCost,
      byQueryType,
      averageTokensPerQuery: totalQueries > 0 ? Math.round(totalTokens / totalQueries) : 0,
    }
  }

  /**
   * Get purchase history for a venue
   */
  async getPurchaseHistory(venueId: string, limit: number = 20) {
    const budget = await this.getOrCreateBudget(venueId)

    return prisma.tokenPurchase.findMany({
      where: { budgetId: budget.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  }

  // ==========================================
  // HELPERS
  // ==========================================

  /**
   * Get available token packages
   */
  getTokenPackages() {
    return CONFIG.TOKEN_PACKAGES
  }

  /**
   * Calculate price for a given token amount
   */
  calculatePrice(tokenAmount: number): { priceUsd: number; priceMxn: number } {
    const priceUsd = (tokenAmount / 1000) * CONFIG.PRICE_PER_1K_TOKENS_USD
    const priceMxn = priceUsd * 17 // Approximate USD to MXN
    return { priceUsd, priceMxn }
  }
}

// Export singleton instance
export const tokenBudgetService = new TokenBudgetService()
export default tokenBudgetService
