import { Request, Response, NextFunction } from 'express'
import { tokenBudgetService } from '@/services/dashboard/token-budget.service'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { z } from 'zod'
import type { TokenUsageRecord, TokenPurchase } from '@prisma/client'

// Token pricing config per currency (price per 1,000 tokens)
const TOKEN_PRICING_BY_CURRENCY: Record<string, number> = {
  USD: 0.03, // $0.03 USD per 1,000 tokens
  MXN: 0.6, // $0.60 MXN per 1,000 tokens (~20x USD rate)
  EUR: 0.03, // €0.03 EUR per 1,000 tokens
}

// Default pricing (fallback)
// Subscription: $400 MXN/month includes $600 MXN worth of tokens = 1M tokens
const TOKEN_PRICING = {
  PRICE_PER_1K_TOKENS: 0.03, // $0.03 USD per 1,000 tokens
  FREE_TOKENS_PER_MONTH: 1000000, // 1M tokens (~$600 MXN worth)
}

// Helper to get price for venue's currency
const getTokenPriceForCurrency = (currency: string): number => {
  const upperCurrency = currency.toUpperCase()
  return TOKEN_PRICING_BY_CURRENCY[upperCurrency] || TOKEN_PRICING.PRICE_PER_1K_TOKENS
}

// Validation schemas
// Minimum 20,000 tokens = $0.60 USD to meet Stripe's minimum charge (~$0.50 USD / 10 MXN)
const purchaseTokensSchema = z.object({
  tokenAmount: z.number().int().positive().min(20000).max(1000000),
  paymentMethodId: z.string().min(1).optional(),
})

const updateAutoRechargeSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().int().positive().min(100).max(100000).optional(),
  amount: z.number().int().positive().min(1000).max(100000).optional(),
})

const usageHistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
})

/**
 * GET /tokens/status
 * Get current token budget status for the venue
 */
export const getStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authContext = (req as any).authContext
    const venueId = authContext?.venueId

    if (!venueId) {
      res.status(400).json({
        success: false,
        error: 'Venue ID required',
      })
      return
    }

    // Get venue's currency
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { currency: true },
    })
    const currency = (venue?.currency || 'MXN').toUpperCase()
    const pricePerThousand = getTokenPriceForCurrency(currency)

    const status = await tokenBudgetService.getBudgetStatus(venueId)

    res.json({
      success: true,
      data: {
        ...status,
        pricing: {
          pricePerThousandTokens: pricePerThousand,
          currency,
          freeTokensPerMonth: TOKEN_PRICING.FREE_TOKENS_PER_MONTH,
        },
      },
    })
  } catch (error) {
    logger.error('Failed to get token budget status', { error })
    next(error)
  }
}

/**
 * POST /tokens/purchase
 * Purchase additional tokens - creates a Stripe Invoice with PDF receipt
 * Requires OWNER or ADMIN role
 */
export const purchase = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authContext = (req as any).authContext
    const venueId = authContext?.venueId
    const userId = authContext?.userId

    if (!venueId || !userId) {
      res.status(400).json({
        success: false,
        error: 'Authentication required',
      })
      return
    }

    const validation = purchaseTokensSchema.safeParse(req.body)
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
      return
    }

    const { tokenAmount } = validation.data

    // Get venue's Stripe customer, payment method, and currency
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { stripeCustomerId: true, stripePaymentMethodId: true, currency: true, name: true },
    })

    if (!venue?.stripeCustomerId || !venue?.stripePaymentMethodId) {
      res.status(400).json({
        success: false,
        error: 'No payment method configured. Please add a payment method first.',
      })
      return
    }

    // Use venue's currency (default to MXN for Mexican venues)
    const currency = (venue.currency || 'MXN').toLowerCase()
    const pricePerThousand = getTokenPriceForCurrency(currency)

    // Calculate amount in cents/centavos
    const amountCents = Math.round((tokenAmount / 1000) * pricePerThousand * 100)
    const amountInCurrency = (tokenAmount / 1000) * pricePerThousand

    // Create Stripe Invoice (instead of PaymentIntent) to get downloadable PDF
    const stripe = new (await import('stripe')).default(process.env.STRIPE_SECRET_KEY!)

    // Step 1: Create the invoice
    const invoice = await stripe.invoices.create({
      customer: venue.stripeCustomerId,
      auto_advance: false, // We'll manually finalize
      collection_method: 'charge_automatically',
      default_payment_method: venue.stripePaymentMethodId,
      metadata: {
        type: 'chatbot_tokens_purchase',
        venueId,
        tokenAmount: String(tokenAmount),
        userId,
        currency: currency.toUpperCase(),
      },
    })

    // Step 2: Add line item to the invoice
    await stripe.invoiceItems.create({
      customer: venue.stripeCustomerId,
      invoice: invoice.id,
      amount: amountCents,
      currency,
      description: `${tokenAmount.toLocaleString()} tokens de IA para chatbot`,
    })

    // Step 3: Finalize the invoice (generates PDF)
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id)

    // Step 4: Pay the invoice using the default payment method
    const paidInvoice = await stripe.invoices.pay(invoice.id)

    // Create pending purchase record with invoice ID
    const result = await tokenBudgetService.purchaseTokens({
      venueId,
      tokenAmount,
      userId,
      stripeInvoiceId: paidInvoice.id,
      amountPaid: amountInCurrency,
      currency: currency.toUpperCase(),
    })

    // If payment succeeded immediately
    if (paidInvoice.status === 'paid') {
      await tokenBudgetService.completeInvoicePurchase(paidInvoice.id, {
        invoicePdfUrl: paidInvoice.invoice_pdf || undefined,
        hostedInvoiceUrl: paidInvoice.hosted_invoice_url || undefined,
      })
    }

    res.json({
      success: true,
      data: {
        ...result,
        paymentStatus: paidInvoice.status,
        invoicePdfUrl: paidInvoice.invoice_pdf,
        hostedInvoiceUrl: paidInvoice.hosted_invoice_url,
      },
    })
  } catch (error: any) {
    // Handle Stripe errors
    if (error.type === 'StripeCardError') {
      res.status(400).json({
        success: false,
        error: 'Payment failed: ' + error.message,
      })
      return
    }
    if (error.type === 'StripeInvalidRequestError') {
      res.status(400).json({
        success: false,
        error: 'Payment failed: ' + error.message,
      })
      return
    }
    logger.error('Failed to purchase tokens', { error })
    next(error)
  }
}

/**
 * PUT /tokens/auto-recharge
 * Configure auto-recharge settings
 * Requires OWNER or ADMIN role
 */
export const updateAutoRecharge = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authContext = (req as any).authContext
    const venueId = authContext?.venueId

    if (!venueId) {
      res.status(400).json({
        success: false,
        error: 'Venue ID required',
      })
      return
    }

    const validation = updateAutoRechargeSchema.safeParse(req.body)
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
      return
    }

    const { enabled, threshold, amount } = validation.data

    const budget = await tokenBudgetService.getOrCreateBudget(venueId)

    // Update auto-recharge settings using Prisma directly
    const updated = await prisma.chatbotTokenBudget.update({
      where: { id: budget.id },
      data: {
        autoRechargeEnabled: enabled,
        ...(threshold !== undefined && { autoRechargeThreshold: threshold }),
        ...(amount !== undefined && { autoRechargeAmount: amount }),
      },
    })

    res.json({
      success: true,
      data: {
        autoRechargeEnabled: updated.autoRechargeEnabled,
        autoRechargeThreshold: updated.autoRechargeThreshold,
        autoRechargeAmount: updated.autoRechargeAmount,
      },
    })
  } catch (error) {
    logger.error('Failed to update auto-recharge settings', { error })
    next(error)
  }
}

/**
 * GET /tokens/history
 * Get token usage and purchase history
 * Requires OWNER or ADMIN role
 */
export const getHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authContext = (req as any).authContext
    const venueId = authContext?.venueId

    if (!venueId) {
      res.status(400).json({
        success: false,
        error: 'Venue ID required',
      })
      return
    }

    const validation = usageHistoryQuerySchema.safeParse(req.query)
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: validation.error.errors,
      })
      return
    }

    const { page, limit, startDate, endDate } = validation.data

    // Get budget for this venue
    const budget = await tokenBudgetService.getOrCreateBudget(venueId)

    // Build date filters
    const dateFilter: Record<string, Date> = {}
    if (startDate) dateFilter.gte = new Date(startDate)
    if (endDate) dateFilter.lte = new Date(endDate)

    // Get usage records with pagination
    const [usageRecords, usageCount] = await Promise.all([
      prisma.tokenUsageRecord.findMany({
        where: {
          budgetId: budget.id,
          ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.tokenUsageRecord.count({
        where: {
          budgetId: budget.id,
          ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
        },
      }),
    ])

    // Get purchase records
    const [purchases, purchaseCount] = await Promise.all([
      prisma.tokenPurchase.findMany({
        where: {
          budgetId: budget.id,
          ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.tokenPurchase.count({
        where: {
          budgetId: budget.id,
          ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
        },
      }),
    ])

    res.json({
      success: true,
      data: {
        usage: {
          records: usageRecords.map((r: TokenUsageRecord) => ({
            id: r.id,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            totalTokens: r.totalTokens,
            queryType: r.queryType,
            estimatedCost: r.estimatedCost.toString(),
            createdAt: r.createdAt,
          })),
          pagination: {
            page,
            limit,
            total: usageCount,
            totalPages: Math.ceil(usageCount / limit),
          },
        },
        purchases: {
          records: purchases.map((p: TokenPurchase) => ({
            id: p.id,
            tokenAmount: p.tokenAmount,
            amountPaid: p.amountPaid.toString(),
            purchaseType: p.purchaseType,
            status: p.status,
            createdAt: p.createdAt,
            completedAt: p.completedAt,
            stripeReceiptUrl: p.stripeReceiptUrl,
            stripeInvoicePdfUrl: p.stripeInvoicePdfUrl,
          })),
          pagination: {
            page,
            limit,
            total: purchaseCount,
            totalPages: Math.ceil(purchaseCount / limit),
          },
        },
      },
    })
  } catch (error) {
    logger.error('Failed to get token history', { error })
    next(error)
  }
}

/**
 * GET /tokens/analytics
 * Get usage analytics for the venue
 * Requires OWNER or ADMIN role
 */
export const getAnalytics = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authContext = (req as any).authContext
    const venueId = authContext?.venueId

    if (!venueId) {
      res.status(400).json({
        success: false,
        error: 'Venue ID required',
      })
      return
    }

    const days = parseInt(req.query.days as string) || 30

    // Calculate start and end dates based on days param
    const endDate = new Date()
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    const analytics = await tokenBudgetService.getUsageAnalytics(venueId, {
      startDate,
      endDate,
    })

    res.json({
      success: true,
      data: analytics,
    })
  } catch (error) {
    logger.error('Failed to get token analytics', { error })
    next(error)
  }
}
