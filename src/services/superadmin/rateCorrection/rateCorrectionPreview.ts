import { AccountType, Payment } from '@prisma/client'
import { determineTransactionCardType } from '../../payments/transactionCost.service' // read-only reuse (safe)
import { recomputeEconomics, RateStructureLike, RecomputeResult } from './rateRecompute'
import prisma from '@/utils/prismaClient'
import { resolveMerchantAccountId, buildScopeWhere } from './rateCorrectionScope'

export function recomputePaymentEconomics(
  payment: Pick<Payment, 'amount' | 'tipAmount' | 'method' | 'cardBrand' | 'processorData'>,
  venuePricing: RateStructureLike,
  providerCost: RateStructureLike | null,
): { transactionType: ReturnType<typeof determineTransactionCardType>; after: RecomputeResult } {
  const isInternational = (payment.processorData as any)?.isInternational || false
  const transactionType = determineTransactionCardType(payment.method, payment.cardBrand, isInternational)
  const amount = parseFloat(payment.amount.toString()) + parseFloat(payment.tipAmount?.toString() || '0')
  const after = recomputeEconomics({ amount, transactionType, venuePricing, providerCost })
  return { transactionType, after }
}

export interface PreviewArgs {
  venueId: string
  accountType: AccountType
  newVenueRates?: RateStructureLike | null
  newProviderRates?: RateStructureLike | null
  dateFrom?: Date
  dateTo?: Date
  missingCostMode: 'FIX_PAYMENT_ONLY' | 'CREATE_COST'
}

export interface PreviewResult {
  merchantAccountId: string
  inScopeCount: number
  withCostCount: number
  missingCostCount: number
  beforeFeeTotal: number
  afterFeeTotal: number
  estimatedImpact: number
  negativeMarginCount: number
  costStructureAvailable: boolean
  venuePricingAvailable: boolean
}

export async function previewRateCorrection(args: PreviewArgs): Promise<PreviewResult> {
  const merchantAccountId = await resolveMerchantAccountId(args.venueId, args.accountType)
  const where = buildScopeWhere({ venueId: args.venueId, merchantAccountId, dateFrom: args.dateFrom, dateTo: args.dateTo })

  const [payments, activeVenue, activeProvider] = await Promise.all([
    prisma.payment.findMany({
      where,
      select: { id: true, amount: true, tipAmount: true, method: true, cardBrand: true, processorData: true, feeAmount: true },
    }),
    prisma.venuePricingStructure.findFirst({
      where: { venueId: args.venueId, accountType: args.accountType, active: true },
      orderBy: { effectiveFrom: 'desc' },
    }),
    prisma.providerCostStructure.findFirst({ where: { merchantAccountId, active: true }, orderBy: { effectiveFrom: 'desc' } }),
  ])

  const effVenue: RateStructureLike | null = args.newVenueRates ?? (activeVenue as RateStructureLike | null)
  const effProvider: RateStructureLike | null = args.newProviderRates ?? (activeProvider as RateStructureLike | null)

  const costPaymentIds = new Set(
    (await prisma.transactionCost.findMany({ where: { paymentId: { in: payments.map(p => p.id) } }, select: { paymentId: true } })).map(
      c => c.paymentId,
    ),
  )

  let beforeFeeTotal = 0
  let afterFeeTotal = 0
  let missingCostCount = 0
  let negativeMarginCount = 0
  for (const p of payments) {
    beforeFeeTotal += parseFloat(p.feeAmount.toString())
    if (!costPaymentIds.has(p.id)) missingCostCount++
    if (effVenue) {
      const { after } = recomputePaymentEconomics(p, effVenue, effProvider)
      afterFeeTotal += after.feeAmount
      if (after.grossProfit < 0) negativeMarginCount++
    }
  }

  return {
    merchantAccountId,
    inScopeCount: payments.length,
    withCostCount: payments.length - missingCostCount,
    missingCostCount,
    beforeFeeTotal,
    afterFeeTotal,
    estimatedImpact: afterFeeTotal - beforeFeeTotal,
    negativeMarginCount,
    costStructureAvailable: !!effProvider,
    venuePricingAvailable: !!effVenue,
  }
}
