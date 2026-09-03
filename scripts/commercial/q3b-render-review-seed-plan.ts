export const Q3B_RENDER_REVIEW_CONFIRMATION = 'avq-q3b-20260902-a91e-staging-db'
export const Q3B_RENDER_REVIEW_DATABASE = 'avoqado_q3b_preview'

export const Q3B_RENDER_REVIEW_CATALOG = Object.freeze({
  sourceKey: 'Q3B_RENDER_CONFIGURATOR_CATALOG_20260902',
  requiredPackageCapabilities: Object.freeze({
    PRO: Object.freeze(['POS_CORE']),
    PREMIUM: Object.freeze(['KITCHEN_DISPLAY', 'MULTI_LOCATION', 'POS_CORE']),
    ENTERPRISE: Object.freeze(['KITCHEN_DISPLAY', 'MULTI_LOCATION', 'POS_CORE']),
  }),
})

export const Q3B_RENDER_REVIEW_OFFER = Object.freeze({
  draftId: 'q3b-review-pos-50-offer-draft-v3',
  code: 'Q3B_REVIEW_POS_50',
  ruleCode: 'POS_FIXED_50',
  amountMinor: 5_000n,
  cycles: 3,
})

export const Q3B_RENDER_REVIEW_MAIN_SELECTIONS = Object.freeze([
  Object.freeze({ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }),
  Object.freeze({
    targetType: 'PRODUCT' as const,
    targetCode: 'TABLE_SERVICE_MODULE',
    priceCode: 'TABLE_SERVICE_MONTHLY',
    quantity: 1,
  }),
  Object.freeze({
    targetType: 'PRODUCT' as const,
    targetCode: 'KITCHEN_DISPLAY_MODULE',
    priceCode: 'KITCHEN_DISPLAY_MONTHLY',
    quantity: 1,
  }),
  Object.freeze({ targetType: 'PRODUCT' as const, targetCode: 'CFDI_MODULE', priceCode: 'CFDI_MONTHLY', quantity: 1 }),
] as const)

export const Q3B_RENDER_REVIEW_SPEI_SELECTIONS = Object.freeze([
  Object.freeze({ targetType: 'PRODUCT' as const, targetCode: 'POS', priceCode: 'POS_MONTHLY', quantity: 1 }),
] as const)

export const Q3B_RENDER_REVIEW_MONEY = Object.freeze({
  mainCurrentTotalMinor: '78532',
  mainRenewalTotalMinor: '101616',
  speiCurrentTotalMinor: '5800',
  speiRenewalTotalMinor: '28884',
  policyDualApprovalThresholdMinor: 500_000n,
})

type Q3bRenderReviewSeedEnvironment = Readonly<{
  NODE_ENV?: string
  DEMO_MODE?: string
  COMMERCIAL_V2_CHECKOUT_MODE?: string
  Q3B_RENDER_REVIEW_SEED_CONFIRM?: string
}>

export function assertQ3bRenderReviewSeedTarget(
  rawDatabaseUrl: string | undefined,
  environment: Q3bRenderReviewSeedEnvironment,
): URL {
  try {
    if (!rawDatabaseUrl) throw new Error('missing')
    const url = new URL(rawDatabaseUrl)
    const databaseName = url.pathname.replace(/^\//u, '')
    const isRenderPostgres = /^dpg-[a-z0-9-]+\.[a-z0-9-]+-postgres\.render\.com$/u.test(
      url.hostname,
    )
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.username ||
      !url.password ||
      !isRenderPostgres ||
      databaseName !== Q3B_RENDER_REVIEW_DATABASE ||
      environment.NODE_ENV !== 'staging' ||
      environment.DEMO_MODE !== 'true' ||
      environment.COMMERCIAL_V2_CHECKOUT_MODE !== 'OFF' ||
      environment.Q3B_RENDER_REVIEW_SEED_CONFIRM !== Q3B_RENDER_REVIEW_CONFIRMATION
    ) {
      throw new Error('unsafe')
    }
    return url
  } catch {
    throw new Error('COMMERCIAL_Q3B_RENDER_REVIEW_SEED_TARGET_REJECTED')
  }
}

export const Q3B_RENDER_REVIEW_MAIN_CONTRACT = Object.freeze({
  quoteId: 'q3b-review-main-quote-v3',
  acceptanceId: 'q3b-review-main-acceptance-v3',
  quoteIdempotencyKey: 'q3b.review.main.quote.v3.20260902',
  acceptanceIdempotencyKey: 'q3b.review.main.acceptance.v3.20260902',
  contractIdempotencyKey: 'q3b.review.main.contract.v1.20260902',
})

export const Q3B_RENDER_REVIEW_SCENARIOS = Object.freeze([
  Object.freeze({
    key: 'PENDING_REVIEW',
    quoteId: 'q3b-review-spei-pending-quote-v3',
    acceptanceId: 'q3b-review-spei-pending-acceptance-v3',
    bankReference: 'AVQ-DEMO-PENDING',
  }),
  Object.freeze({
    key: 'AWAITING_SECOND_APPROVAL',
    quoteId: 'q3b-review-spei-awaiting-quote-v3',
    acceptanceId: 'q3b-review-spei-awaiting-acceptance-v3',
    bankReference: null,
  }),
  Object.freeze({
    key: 'REJECTED',
    quoteId: 'q3b-review-spei-rejected-quote-v3',
    acceptanceId: 'q3b-review-spei-rejected-acceptance-v3',
    bankReference: 'AVQ-DEMO-REJECTED',
  }),
  Object.freeze({
    key: 'RECONCILED',
    quoteId: 'q3b-review-spei-reconciled-quote-v3',
    acceptanceId: 'q3b-review-spei-reconciled-acceptance-v3',
    bankReference: 'AVQ-DEMO-RECONCILED',
  }),
] as const)
