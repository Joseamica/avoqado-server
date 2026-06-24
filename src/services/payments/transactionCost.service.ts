import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { PaymentMethod, CardBrand, TransactionCardType, OriginSystem, AccountType, PricingStructureSource } from '@prisma/client'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import { getEffectivePaymentConfig, getEffectivePricing } from '../organization-payment-config.service'
import { calculatePaymentSettlement } from './settlementCalculation.service'

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
 * Resolved cost context for the ROSTER path (PR-2, flag ON). Mirrors the locals the
 * legacy slot path produces, plus the durable audit fields the new schema records.
 */
interface RosterCostContext {
  merchantAccount: { id: string } | null
  providerCostStructure: any
  venuePricingStructure: any
  pricingStructureSource: PricingStructureSource
  organizationPricingStructureId: string | null
  providerCostFallbackUsed: boolean
  venuePricingFallbackUsed: boolean
}

/**
 * Roster-based resolution (PR-2). Active only when a venue's
 * `VenuePaymentConfig.rosterRolloutEnabled` is true.
 *
 * Resolves cost/pricing against the venue ROSTER (`VenueMerchantAccount`, which
 * already includes materialized org accounts) keyed by the account that actually
 * processed the card (`Payment.merchantAccountId`) — NOT the 3 legacy slots. This
 * lets a 4th+ account resolve correctly instead of silently falling back to PRIMARY
 * (the amaena bug class).
 *
 * Resolution order:
 *   - account      = payment.merchantAccountId (the card's processor) ?? primary slot
 *   - provider cost= that account's active structure at the payment's date; if missing,
 *                    fall back to PRIMARY's cost (NEVER drop the cost record), flagged.
 *   - venue price  = per-account → legacy(legacySlotType) → PRIMARY (flagged), all
 *                    resolved at the payment's date (historical-correct).
 */
export async function resolveRosterCostContext(payment: any): Promise<RosterCostContext> {
  const venueId: string = payment.venueId

  // The venue roster: the universe of accounts (incl. materialized org accounts).
  const roster = await prisma.venueMerchantAccount.findMany({
    where: { venueId },
    select: { merchantAccountId: true, legacySlotType: true },
  })

  // Resolve the account that ran the card. Manual/QR payments (no recorded account)
  // anchor to the PRIMARY slot, mirroring the legacy path.
  const primaryRow = roster.find(r => r.legacySlotType === AccountType.PRIMARY)
  const processingAccountId: string | undefined = payment.merchantAccountId ?? primaryRow?.merchantAccountId

  if (!processingAccountId) {
    return {
      merchantAccount: null,
      providerCostStructure: null,
      venuePricingStructure: null,
      pricingStructureSource: PricingStructureSource.VENUE,
      organizationPricingStructureId: null,
      providerCostFallbackUsed: false,
      venuePricingFallbackUsed: false,
    }
  }

  const row = roster.find(r => r.merchantAccountId === processingAccountId)
  const legacySlotType = row?.legacySlotType ?? undefined

  if (payment.merchantAccountId && !row) {
    // Account isn't in the roster (stale/offline TPV, or pre-backfill). We still cost
    // it against the processing account; pricing falls back to PRIMARY below.
    logger.warn('Roster path: payment account not found in venue roster', {
      paymentId: payment.id,
      venueId,
      merchantAccountId: payment.merchantAccountId,
    })
  }

  // ----- Provider cost (what Avoqado pays), keyed by the processing account -----
  let providerCostFallbackUsed = false
  let providerCostStructure = await findActiveProviderCostStructure(processingAccountId, payment.createdAt)
  if (!providerCostStructure && payment.type !== 'TEST') {
    const primaryId = primaryRow?.merchantAccountId
    if (primaryId && primaryId !== processingAccountId) {
      const primaryCost = await findActiveProviderCostStructure(primaryId, payment.createdAt)
      if (primaryCost) {
        providerCostStructure = primaryCost
        providerCostFallbackUsed = true
        logger.warn('Roster path: no provider cost for processing account; fell back to PRIMARY provider cost', {
          paymentId: payment.id,
          venueId,
          processingAccountId,
          primaryId,
        })
      }
    }
  }

  // ----- Venue pricing (what Avoqado charges): per-account → legacy(slot) → PRIMARY -----
  let venuePricingFallbackUsed = false
  let pricingResult = await getEffectivePricing(venueId, legacySlotType as AccountType | undefined, {
    merchantAccountId: processingAccountId,
    effectiveAt: payment.createdAt,
  })

  const empty = (r: typeof pricingResult) => !r || r.pricing.length === 0
  if (empty(pricingResult) && legacySlotType !== AccountType.PRIMARY) {
    // Never worse than PRIMARY: an account with no per-account / no slot pricing still
    // gets a cost row, priced at PRIMARY's rate, flagged for the config-gap follow-up.
    const primaryPricing = await getEffectivePricing(venueId, AccountType.PRIMARY, { effectiveAt: payment.createdAt })
    if (!empty(primaryPricing)) {
      pricingResult = primaryPricing
      venuePricingFallbackUsed = true
    }
  }

  const structure = pricingResult && pricingResult.pricing.length > 0 ? pricingResult.pricing[0] : null
  const fromOrg = pricingResult?.source === 'organization'

  return {
    merchantAccount: { id: processingAccountId },
    providerCostStructure,
    venuePricingStructure: structure,
    // Org pricing is NOT materialized — record WHICH org structure was used so refunds
    // and reconciliation can mirror the exact context (spec R7/R8).
    pricingStructureSource: fromOrg ? PricingStructureSource.ORG : PricingStructureSource.VENUE,
    organizationPricingStructureId: fromOrg ? (structure?.id ?? null) : null,
    providerCostFallbackUsed,
    venuePricingFallbackUsed,
  }
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
 * Calcula la tasa EFECTIVA aplicada al monto de la transacción, respetando
 * el flag `includesTax` de la pricing/cost structure.
 *
 *   - structure.includesTax === false → tasa BASE; aplicar tax (default 16%).
 *   - structure.includesTax === true  → tasa final; usar as-is.
 *   - structure.includesTax === null  → legacy; tratar como `true` para
 *     preservar el comportamiento histórico (no se sumaba tax).
 *
 * `taxRate` se persiste por estructura (default 0.16 = IVA México) — leerlo
 * de la columna evita asumir 16% hardcoded por si en el futuro hay venues
 * con jurisdicciones diferentes.
 */
function applyTaxIfNeeded(structure: any, baseRate: number): number {
  if (structure?.includesTax === false) {
    // Ojo: NO usar `structure.taxRate ? ... : 0.16` — un taxRate=0 (jurisdicción
    // sin IVA) es válido y caería en el fallback. Chequeamos null/undefined
    // explícitamente. NaN se cubre con isFinite para protegerse de strings.
    let tax = 0.16
    if (structure.taxRate !== null && structure.taxRate !== undefined) {
      const parsed = parseFloat(structure.taxRate.toString())
      if (Number.isFinite(parsed)) tax = parsed
    }
    return baseRate * (1 + tax)
  }
  return baseRate
}

export interface CostAmounts {
  amount: number
  providerRate: number
  providerFixedFee: number
  providerCostAmount: number
  venueRate: number
  venueFixedFee: number
  venueChargeAmount: number
  totalProviderCost: number
  totalVenueCharge: number
  grossProfit: number
  profitMargin: number
}

/**
 * Pure cost/revenue math for one transaction. Extracted so the live cost engine
 * (createTransactionCost) and the read-only recompute-diff gate compute the EXACT
 * same numbers from the same inputs — no DB, no side effects. Commission is charged
 * on the total processed amount (base + tip).
 */
export function computeCostAmounts(params: {
  baseAmount: number
  tipAmount: number
  isTest: boolean
  transactionType: TransactionCardType
  providerCostStructure: any
  venuePricingStructure: any
}): CostAmounts {
  const { baseAmount, tipAmount, isTest, transactionType, providerCostStructure, venuePricingStructure } = params
  const amount = baseAmount + tipAmount

  // TEST payments are zero-rated (audit trail only).
  let providerRate = 0
  let providerFixedFee = 0
  let venueRate = 0
  let venueFixedFee = 0

  if (!isTest) {
    const providerBaseRate = getRateForTransactionType(providerCostStructure, transactionType)
    providerRate = applyTaxIfNeeded(providerCostStructure, providerBaseRate)
    providerFixedFee = providerCostStructure?.fixedCostPerTransaction
      ? parseFloat(providerCostStructure.fixedCostPerTransaction.toString())
      : 0

    const venueBaseRate = getRateForTransactionType(venuePricingStructure, transactionType)
    venueRate = applyTaxIfNeeded(venuePricingStructure, venueBaseRate)
    venueFixedFee = venuePricingStructure?.fixedFeePerTransaction ? parseFloat(venuePricingStructure.fixedFeePerTransaction.toString()) : 0
  }

  const providerCostAmount = amount * providerRate
  const venueChargeAmount = amount * venueRate
  const totalProviderCost = providerCostAmount + providerFixedFee
  const totalVenueCharge = venueChargeAmount + venueFixedFee
  const grossProfit = totalVenueCharge - totalProviderCost
  const profitMargin = totalVenueCharge > 0 ? grossProfit / totalVenueCharge : 0

  return {
    amount,
    providerRate,
    providerFixedFee,
    providerCostAmount,
    venueRate,
    venueFixedFee,
    venueChargeAmount,
    totalProviderCost,
    totalVenueCharge,
    grossProfit,
    profitMargin,
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

  // PR-2 rollout flag. When a venue opts in (after its recompute-diff gate passes),
  // cost/pricing resolve against the full account ROSTER instead of the 3 legacy
  // slots. Default OFF → byte-for-byte the historical slot behavior below. The flag
  // lives on VenuePaymentConfig only; org-inherited configs have none → stay OFF.
  const rosterEnabled = configSource === 'venue' && (paymentConfig as any).rosterRolloutEnabled === true

  // Cost context produced by whichever path runs, then consumed by Steps 5-7.
  let merchantAccount: { id: string } | null = null
  let providerCostStructure: any = null
  let venuePricingStructure: any = null
  let pricingStructureSource: PricingStructureSource = PricingStructureSource.VENUE
  let organizationPricingStructureId: string | null = null
  let providerCostFallbackUsed = false
  let venuePricingFallbackUsed = false

  if (rosterEnabled) {
    // ===== Step 2-4 · ROSTER path (PR-2) =====
    const ctx = await resolveRosterCostContext(payment)
    merchantAccount = ctx.merchantAccount
    providerCostStructure = ctx.providerCostStructure
    venuePricingStructure = ctx.venuePricingStructure
    pricingStructureSource = ctx.pricingStructureSource
    organizationPricingStructureId = ctx.organizationPricingStructureId
    providerCostFallbackUsed = ctx.providerCostFallbackUsed
    venuePricingFallbackUsed = ctx.venuePricingFallbackUsed

    if (!merchantAccount) {
      throw new BadRequestError(`Venue ${payment.venueId} has no merchant account to attribute payment ${paymentId} to`)
    }
    logger.info('Merchant account identified (roster path)', {
      paymentId,
      merchantAccountId: merchantAccount.id,
      configSource,
      pricingStructureSource,
      providerCostFallbackUsed,
      venuePricingFallbackUsed,
    })
    if (!providerCostStructure && payment.type !== 'TEST') {
      throw new BadRequestError(
        `No active provider cost structure found for payment ${paymentId} (roster path, incl. PRIMARY fallback) at ${payment.createdAt}`,
      )
    }
    if (!venuePricingStructure && payment.type !== 'TEST') {
      throw new BadRequestError(
        `No active venue pricing structure found for venue ${payment.venueId} (roster path, incl. PRIMARY fallback) at ${payment.createdAt}`,
      )
    }
  } else {
    // ===== Step 2-4 · LEGACY slot path (unchanged; guarded by the regression suite) =====

    // Resolve WHICH configured account actually processed this payment. A venue
    // can have PRIMARY / SECONDARY / TERTIARY merchant accounts, each with its
    // own venue pricing. The TPV routing layer persists the processing account on
    // `payment.merchantAccountId` — honor it so the venue is charged with the
    // pricing of the account that actually ran the card (e.g. an aggregator
    // account at 8%), instead of always assuming PRIMARY. Falls back to PRIMARY
    // when the payment has no recorded account (manual/QR payments) or it doesn't
    // match any configured slot.
    let slotAccount = paymentConfig.primaryAccount
    let accountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' = 'PRIMARY'

    if (payment.merchantAccountId) {
      if (paymentConfig.secondaryAccount?.id === payment.merchantAccountId) {
        slotAccount = paymentConfig.secondaryAccount
        accountType = 'SECONDARY'
      } else if (paymentConfig.tertiaryAccount?.id === payment.merchantAccountId) {
        slotAccount = paymentConfig.tertiaryAccount
        accountType = 'TERTIARY'
      } else if (paymentConfig.primaryAccount?.id === payment.merchantAccountId) {
        accountType = 'PRIMARY'
      } else {
        logger.warn('Payment processed by an account not in the venue payment config; falling back to PRIMARY pricing', {
          paymentId,
          paymentMerchantAccountId: payment.merchantAccountId,
          primaryAccountId: paymentConfig.primaryAccount?.id,
          secondaryAccountId: paymentConfig.secondaryAccount?.id,
          tertiaryAccountId: paymentConfig.tertiaryAccount?.id,
        })
      }
    }

    if (!slotAccount) {
      throw new BadRequestError(`Venue ${payment.venueId} has no ${accountType.toLowerCase()} merchant account configured`)
    }
    merchantAccount = slotAccount

    logger.info('Merchant account identified', {
      paymentId,
      merchantAccountId: merchantAccount.id,
      accountType,
      configSource,
    })

    // Step 3: Get Provider Cost Structure
    providerCostStructure = await findActiveProviderCostStructure(merchantAccount.id, payment.createdAt)

    if (!providerCostStructure && payment.type !== 'TEST') {
      throw new BadRequestError(`No active provider cost structure found for merchant account ${merchantAccount.id} at ${payment.createdAt}`)
    }

    // Step 4: Get Venue Pricing Structure
    //
    // Prefer the resolved slot's pricing. If that slot has no active pricing
    // structure (a real prod case: a SECONDARY/TERTIARY account that was never
    // given its own venue rate), fall back to PRIMARY pricing instead of failing.
    // Failing here would leave the payment with NO TransactionCost at all (and no
    // netSettlementAmount) — strictly worse than the old always-PRIMARY behavior.
    // This keeps routing-by-slot "never worse than PRIMARY" while still using the
    // correct slot pricing whenever it exists; the warning surfaces the config gap
    // so the missing slot pricing can be created and the payments recomputed.
    let pricingAccountType: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' = accountType
    venuePricingStructure = await findActiveVenuePricingStructure(payment.venueId, accountType, payment.createdAt)

    if (!venuePricingStructure && accountType !== 'PRIMARY') {
      logger.warn('No venue pricing for resolved slot; falling back to PRIMARY pricing', {
        paymentId,
        venueId: payment.venueId,
        resolvedAccountType: accountType,
        merchantAccountId: merchantAccount.id,
      })
      pricingAccountType = 'PRIMARY'
      venuePricingStructure = await findActiveVenuePricingStructure(payment.venueId, 'PRIMARY', payment.createdAt)
    }

    if (!venuePricingStructure && payment.type !== 'TEST') {
      throw new BadRequestError(
        `No active venue pricing structure found for venue ${payment.venueId}, account type ${pricingAccountType} at ${payment.createdAt}`,
      )
    }
  }

  // ========================================
  // Step 5: Calculate Costs and Revenue
  // ========================================

  // IMPORTANT: Use total processed amount (including tip) for cost calculation. The
  // math lives in computeCostAmounts (pure) so the recompute-diff gate produces
  // byte-identical numbers. La tasa efectiva considera `includesTax` (tasa BASE +
  // IVA cuando includesTax=false) dentro de computeCostAmounts.
  const baseAmount = parseFloat(payment.amount.toString())
  const tipAmount = parseFloat(payment.tipAmount?.toString() || '0')

  const {
    amount,
    providerRate,
    providerFixedFee,
    providerCostAmount,
    venueRate,
    venueFixedFee,
    venueChargeAmount,
    grossProfit,
    profitMargin,
  } = computeCostAmounts({
    baseAmount,
    tipAmount,
    isTest: payment.type === 'TEST',
    transactionType,
    providerCostStructure,
    venuePricingStructure,
  })

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

  // On the roster path, when the rate came from ORG-level pricing the venue FK must
  // stay null (org pricing is not materialized) and the org structure is recorded via
  // organizationPricingStructureId instead. The legacy path is unchanged.
  const venuePricingStructureIdToStore =
    rosterEnabled && pricingStructureSource === PricingStructureSource.ORG ? null : venuePricingStructure?.id

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
      venuePricingStructureId: venuePricingStructureIdToStore,

      // Profit calculation
      grossProfit,
      profitMargin,

      // Roster path (PR-2): durable resolution audit so reconciliation and refunds
      // can mirror the exact pricing context. Omitted on the legacy path (no change).
      ...(rosterEnabled
        ? {
            pricingStructureSource,
            organizationPricingStructureId,
            providerCostFallbackUsed,
            venuePricingFallbackUsed,
          }
        : {}),
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

  // ========================================
  // Step 7: Populate VenueTransaction settlement metadata
  // ========================================
  // Without this, the dashboard's "saldo disponible" calendar can't show this
  // payment until the manual backfill script runs. Locally wrapped so any
  // failure (missing SettlementConfiguration, etc) is logged but never blocks
  // the cobro — TransactionCost is already saved and the caller has its own
  // try/catch around this whole function.
  try {
    const settlementInfo = await calculatePaymentSettlement(payment, merchantAccount.id, transactionType)

    if (settlementInfo) {
      await prisma.venueTransaction.update({
        where: { paymentId: payment.id },
        data: {
          estimatedSettlementDate: settlementInfo.estimatedSettlementDate,
          netSettlementAmount: settlementInfo.netSettlementAmount,
          settlementConfigId: settlementInfo.settlementConfigId,
        },
      })
      logger.info('Settlement metadata populated', {
        paymentId,
        estimatedSettlementDate: settlementInfo.estimatedSettlementDate,
        netSettlementAmount: settlementInfo.netSettlementAmount,
      })
    } else {
      logger.warn('No active SettlementConfiguration found; settlement metadata left null', {
        paymentId,
        merchantAccountId: merchantAccount.id,
        transactionType,
      })
    }
  } catch (settlementError) {
    logger.error('Failed to populate settlement metadata; payment unaffected', {
      paymentId,
      error: settlementError instanceof Error ? settlementError.message : settlementError,
    })
  }

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
