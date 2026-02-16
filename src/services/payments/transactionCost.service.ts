import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { PaymentMethod, CardBrand, TransactionCardType, OriginSystem } from '@prisma/client'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import { getEffectivePaymentConfig, getEffectivePricing } from '../organization-payment-config.service'

/**
 * TransactionCost Service
 *
 * Handles creation and calculation of transaction costs for Avoqado-processed payments.
 * This service tracks the economics of each payment:
 * - Provider costs (what Avoqado pays to Menta/Clip/etc)
 * - Venue pricing (what Avoqado charges the venue)
 * - Gross profit and profit margin
 *
 * CRITICAL BUSINESS RULE:
 * Only create TransactionCost for payments where:
 * 1. originSystem = AVOQADO (Avoqado processed the payment)
 * 2. method ≠ CASH (processor involved)
 * 3. type ≠ TEST (real payments only, or zero-cost for audit)
 */

/**
 * Determine the transaction card type based on payment method and card brand
 * Used to select the correct rate from ProviderCostStructure/VenuePricingStructure
 *
 * @param method - Payment method from Payment record
 * @param cardBrand - Card brand from Payment record (VISA, MASTERCARD, AMEX, etc)
 * @param isInternational - Whether the card is international (from processorData)
 * @returns TransactionCardType enum value
 */
export function determineTransactionCardType(
  method: PaymentMethod,
  cardBrand: CardBrand | null,
  isInternational?: boolean,
): TransactionCardType {
  // International cards have their own rate tier
  if (isInternational) {
    return TransactionCardType.INTERNATIONAL
  }

  // AMEX has special higher rates
  if (cardBrand === CardBrand.AMERICAN_EXPRESS) {
    return TransactionCardType.AMEX
  }

  // Map payment method to card type
  switch (method) {
    case PaymentMethod.DEBIT_CARD:
      return TransactionCardType.DEBIT
    case PaymentMethod.CREDIT_CARD:
      return TransactionCardType.CREDIT
    default:
      logger.warn('Unexpected payment method for card type determination', { method, cardBrand })
      return TransactionCardType.OTHER
  }
}

/**
 * Find the active provider cost structure for a merchant account at a given date
 *
 * @param merchantAccountId - Merchant account ID
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active ProviderCostStructure or null
 */
export async function findActiveProviderCostStructure(merchantAccountId: string, effectiveDate: Date = new Date()) {
  const costStructure = await prisma.providerCostStructure.findFirst({
    where: {
      merchantAccountId,
      active: true,
      effectiveFrom: { lte: effectiveDate },
      OR: [
        { effectiveTo: null }, // No end date (current)
        { effectiveTo: { gte: effectiveDate } },
      ],
    },
    orderBy: {
      effectiveFrom: 'desc', // Get most recent if multiple match
    },
  })

  if (!costStructure) {
    logger.warn('No active provider cost structure found', { merchantAccountId, effectiveDate })
  }

  return costStructure
}

/**
 * Find the active venue pricing structure for a venue and account type at a given date
 *
 * @param venueId - Venue ID
 * @param accountType - Account type (PRIMARY, SECONDARY, TERTIARY)
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active VenuePricingStructure or null
 */
export async function findActiveVenuePricingStructure(
  venueId: string,
  accountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY',
  effectiveDate: Date = new Date(),
) {
  // Use inheritance: venue pricing → org pricing fallback
  const effective = await getEffectivePricing(venueId, accountType)

  if (!effective) {
    logger.warn('No active pricing structure found (checked venue + org)', { venueId, accountType, effectiveDate })
    return null
  }

  const { pricing, source } = effective
  logger.info('Resolved pricing structure', { venueId, accountType, source, count: pricing.length })

  // Return the most recent pricing structure (already ordered by effectiveFrom desc)
  return pricing[0] || null
}

/**
 * Get the rate for a specific transaction type from a cost/pricing structure
 *
 * @param structure - ProviderCostStructure or VenuePricingStructure
 * @param transactionType - Card type (DEBIT, CREDIT, AMEX, INTERNATIONAL)
 * @returns Rate as Decimal
 */
function getRateForTransactionType(structure: any, transactionType: TransactionCardType): number {
  switch (transactionType) {
    case TransactionCardType.DEBIT:
      return parseFloat(structure.debitRate.toString())
    case TransactionCardType.CREDIT:
      return parseFloat(structure.creditRate.toString())
    case TransactionCardType.AMEX:
      return parseFloat(structure.amexRate.toString())
    case TransactionCardType.INTERNATIONAL:
      return parseFloat(structure.internationalRate.toString())
    default:
      logger.warn('Unknown transaction type for rate lookup', { transactionType })
      return parseFloat(structure.creditRate.toString()) // Default to credit rate
  }
}

/**
 * Main function: Create TransactionCost record for a payment
 *
 * This function:
 * 1. Validates payment eligibility (AVOQADO origin, not CASH, not TEST)
 * 2. Determines transaction card type
 * 3. Finds merchant account from venue payment config
 * 4. Gets provider cost structure (what Avoqado pays)
 * 5. Gets venue pricing structure (what Avoqado charges)
 * 6. Calculates costs, revenue, and profit
 * 7. Creates TransactionCost record
 *
 * @param paymentId - Payment ID to create TransactionCost for
 * @returns Object with transactionCost record, feeAmount, and netAmount (or null if skipped)
 */
export async function createTransactionCost(paymentId: string): Promise<{
  transactionCost: any
  feeAmount: number
  netAmount: number
} | null> {
  logger.info('Creating TransactionCost', { paymentId })

  // Fetch payment with venue info
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      venue: { select: { id: true, organizationId: true } },
    },
  })

  if (!payment) {
    throw new NotFoundError(`Payment ${paymentId} not found`)
  }

  // ========================================
  // CRITICAL BUSINESS RULE: Eligibility Check
  // ========================================

  // Skip if not Avoqado-originated
  if (payment.originSystem !== OriginSystem.AVOQADO) {
    logger.info('Skipping TransactionCost: Payment not originated by Avoqado', {
      paymentId,
      originSystem: payment.originSystem,
    })
    return null
  }

  // Skip if CASH (no processor involved)
  if (payment.method === PaymentMethod.CASH) {
    logger.info('Skipping TransactionCost: Cash payment (no processor cost)', { paymentId })
    return null
  }

  // Handle TEST payments
  if (payment.type === 'TEST') {
    logger.info('Creating zero-cost TransactionCost for TEST payment (audit trail)', { paymentId })
    // TEST payments get TransactionCost with zero costs for audit trail
    // Continue with zero rates below
  }

  // ========================================
  // Step 1: Determine Transaction Card Type
  // ========================================

  const processorData = payment.processorData as any
  const isInternational = processorData?.isInternational || false

  const transactionType = determineTransactionCardType(payment.method, payment.cardBrand, isInternational)

  logger.info('Transaction type determined', {
    paymentId,
    method: payment.method,
    cardBrand: payment.cardBrand,
    isInternational,
    transactionType,
  })

  // ========================================
  // Step 2: Find Merchant Account (venue → org inheritance)
  // ========================================

  const effective = await getEffectivePaymentConfig(payment.venueId)
  if (!effective) {
    throw new BadRequestError(`Venue ${payment.venueId} has no payment configuration (checked venue + org)`)
  }

  const { config: paymentConfig, source: configSource } = effective

  // Use PRIMARY account by default (TODO: support routing to SECONDARY/TERTIARY based on BIN/amount)
  const merchantAccount = paymentConfig.primaryAccount
  if (!merchantAccount) {
    throw new BadRequestError(`Venue ${payment.venueId} has no primary merchant account configured`)
  }

  const accountType = 'PRIMARY' // TODO: Determine actual account type used for this payment

  logger.info('Merchant account identified', {
    paymentId,
    merchantAccountId: merchantAccount.id,
    accountType,
    configSource,
  })

  // ========================================
  // Step 3: Get Provider Cost Structure
  // ========================================

  const providerCostStructure = await findActiveProviderCostStructure(merchantAccount.id, payment.createdAt)

  if (!providerCostStructure && payment.type !== 'TEST') {
    throw new BadRequestError(`No active provider cost structure found for merchant account ${merchantAccount.id} at ${payment.createdAt}`)
  }

  // ========================================
  // Step 4: Get Venue Pricing Structure
  // ========================================

  const venuePricingStructure = await findActiveVenuePricingStructure(payment.venueId, accountType, payment.createdAt)

  if (!venuePricingStructure && payment.type !== 'TEST') {
    throw new BadRequestError(
      `No active venue pricing structure found for venue ${payment.venueId}, account type ${accountType} at ${payment.createdAt}`,
    )
  }

  // ========================================
  // Step 5: Calculate Costs and Revenue
  // ========================================

  // IMPORTANT: Use total processed amount (including tip) for cost calculation
  // The payment processor charges commission on ALL money that passes through the terminal
  const baseAmount = parseFloat(payment.amount.toString())
  const tipAmount = parseFloat(payment.tipAmount?.toString() || '0')
  const amount = baseAmount + tipAmount

  logger.info('Transaction amount calculated', {
    paymentId,
    baseAmount,
    tipAmount,
    totalAmount: amount,
  })

  // For TEST payments, use zero rates
  let providerRate = 0
  let providerFixedFee = 0
  let venueRate = 0
  let venueFixedFee = 0

  if (payment.type !== 'TEST') {
    // Get rates from cost/pricing structures
    providerRate = getRateForTransactionType(providerCostStructure!, transactionType)
    providerFixedFee = providerCostStructure!.fixedCostPerTransaction
      ? parseFloat(providerCostStructure!.fixedCostPerTransaction.toString())
      : 0

    venueRate = getRateForTransactionType(venuePricingStructure!, transactionType)
    venueFixedFee = venuePricingStructure!.fixedFeePerTransaction ? parseFloat(venuePricingStructure!.fixedFeePerTransaction.toString()) : 0
  }

  // Calculate costs
  const providerCostAmount = amount * providerRate
  const venueChargeAmount = amount * venueRate

  const totalProviderCost = providerCostAmount + providerFixedFee
  const totalVenueCharge = venueChargeAmount + venueFixedFee

  // Calculate profit
  const grossProfit = totalVenueCharge - totalProviderCost
  const profitMargin = totalVenueCharge > 0 ? grossProfit / totalVenueCharge : 0

  logger.info('Transaction cost calculated', {
    paymentId,
    amount,
    transactionType,
    providerRate,
    providerCostAmount,
    providerFixedFee,
    venueRate,
    venueChargeAmount,
    venueFixedFee,
    grossProfit,
    profitMargin,
  })

  // ========================================
  // Step 6: Create TransactionCost Record
  // ========================================

  const transactionCost = await prisma.transactionCost.create({
    data: {
      paymentId: payment.id,
      merchantAccountId: merchantAccount.id,
      transactionType,
      amount,

      // Provider costs (what Avoqado pays)
      providerRate,
      providerCostAmount,
      providerFixedFee,
      providerCostStructureId: providerCostStructure?.id,

      // Venue pricing (what Avoqado charges)
      venueRate,
      venueChargeAmount,
      venueFixedFee,
      venuePricingStructureId: venuePricingStructure?.id,

      // Profit calculation
      grossProfit,
      profitMargin,
    },
  })

  // Calculate fee and net amounts for caller
  const totalFee = venueChargeAmount + venueFixedFee
  const netAmountCalculated = amount - totalFee

  logger.info('TransactionCost created successfully', {
    transactionCostId: transactionCost.id,
    paymentId,
    grossProfit,
    profitMargin,
    feeAmount: totalFee,
    netAmount: netAmountCalculated,
  })

  return {
    transactionCost,
    feeAmount: totalFee,
    netAmount: netAmountCalculated,
  }
}

/**
 * Create a negative TransactionCost record for a refund
 *
 * This function mirrors the original payment's TransactionCost but with negative values.
 * This ensures that:
 * - SUM(grossProfit) correctly subtracts refunded amounts
 * - Dashboard totals and profit analytics are accurate
 * - Refunds are properly tracked in financial reports
 *
 * Example:
 * - Original payment: $11.00, profit = $0.02
 * - Refund: -$11.00, profit = -$0.02
 * - Net profit after refund: $0.00 ✓
 *
 * @param refundPaymentId - The ID of the refund Payment record
 * @param originalPaymentId - The ID of the original Payment that was refunded
 * @returns The created TransactionCost record or null if original had no TransactionCost
 */
export async function createRefundTransactionCost(refundPaymentId: string, originalPaymentId: string): Promise<any | null> {
  logger.info('Creating refund TransactionCost', { refundPaymentId, originalPaymentId })

  // Find the original payment's TransactionCost
  const originalTransactionCost = await prisma.transactionCost.findUnique({
    where: { paymentId: originalPaymentId },
  })

  if (!originalTransactionCost) {
    logger.info('No TransactionCost found for original payment, skipping refund TransactionCost', {
      refundPaymentId,
      originalPaymentId,
    })
    return null
  }

  // Fetch the refund payment to get amount info
  const refundPayment = await prisma.payment.findUnique({
    where: { id: refundPaymentId },
  })

  if (!refundPayment) {
    throw new NotFoundError(`Refund payment ${refundPaymentId} not found`)
  }

  // Calculate the refund ratio (for partial refunds)
  // If original was $100 and refund is $50, ratio = 0.5
  const originalAmount = parseFloat(originalTransactionCost.amount.toString())
  const refundAmount = Math.abs(parseFloat(refundPayment.amount.toString()))
  const refundRatio = originalAmount > 0 ? refundAmount / originalAmount : 1

  // Create negative TransactionCost mirroring the original (scaled by refund ratio for partial refunds)
  const refundTransactionCost = await prisma.transactionCost.create({
    data: {
      paymentId: refundPaymentId,
      merchantAccountId: originalTransactionCost.merchantAccountId,
      transactionType: originalTransactionCost.transactionType,

      // Negative amount
      amount: -refundAmount,

      // Provider costs (negative - Avoqado "un-pays" these)
      providerRate: originalTransactionCost.providerRate,
      providerCostAmount: -(parseFloat(originalTransactionCost.providerCostAmount.toString()) * refundRatio),
      providerFixedFee: refundRatio === 1 ? -parseFloat(originalTransactionCost.providerFixedFee.toString()) : 0,
      providerCostStructureId: originalTransactionCost.providerCostStructureId,

      // Venue pricing (negative - Avoqado "un-charges" these)
      venueRate: originalTransactionCost.venueRate,
      venueChargeAmount: -(parseFloat(originalTransactionCost.venueChargeAmount.toString()) * refundRatio),
      venueFixedFee: refundRatio === 1 ? -parseFloat(originalTransactionCost.venueFixedFee.toString()) : 0,
      venuePricingStructureId: originalTransactionCost.venuePricingStructureId,

      // Profit calculation (negative - Avoqado "un-earns" this)
      grossProfit: -(parseFloat(originalTransactionCost.grossProfit.toString()) * refundRatio),
      profitMargin: parseFloat(originalTransactionCost.profitMargin.toString()), // Margin stays same (it's a ratio)
    },
  })

  logger.info('Refund TransactionCost created successfully', {
    refundTransactionCostId: refundTransactionCost.id,
    refundPaymentId,
    originalPaymentId,
    grossProfit: refundTransactionCost.grossProfit,
    refundRatio,
  })

  return refundTransactionCost
}
