import {
  assertQ3bRenderReviewSeedTarget,
  Q3B_RENDER_REVIEW_MAIN_SELECTIONS,
  Q3B_RENDER_REVIEW_MONEY,
  Q3B_RENDER_REVIEW_OFFER,
  Q3B_RENDER_REVIEW_SCENARIOS,
} from '../../../scripts/commercial/q3b-render-review-seed-plan'

const safeEnvironment = {
  NODE_ENV: 'staging',
  DEMO_MODE: 'true',
  COMMERCIAL_V2_CHECKOUT_MODE: 'OFF',
  Q3B_RENDER_REVIEW_SEED_CONFIRM: 'avq-q3b-20260902-a91e-staging-db',
} as const

describe('Q3B Render review seed boundary', () => {
  it('accepts only the isolated Q3B Render preview database with money checkout disabled', () => {
    const target = assertQ3bRenderReviewSeedTarget(
      'postgresql://avoqado_q3b_preview_user:secret@dpg-example-a.oregon-postgres.render.com/avoqado_q3b_preview',
      safeEnvironment,
    )

    expect(target.pathname).toBe('/avoqado_q3b_preview')
    expect(target.hostname).toBe('dpg-example-a.oregon-postgres.render.com')
  })

  it.each([
    [
      'wrong database',
      'postgresql://user:secret@dpg-example-a.oregon-postgres.render.com/avoqado_production',
      safeEnvironment,
    ],
    [
      'local database',
      'postgresql://user:secret@localhost:5432/avoqado_q3b_preview',
      safeEnvironment,
    ],
    [
      'checkout enabled',
      'postgresql://user:secret@dpg-example-a.oregon-postgres.render.com/avoqado_q3b_preview',
      { ...safeEnvironment, COMMERCIAL_V2_CHECKOUT_MODE: 'ACTIVE' },
    ],
    [
      'production runtime',
      'postgresql://user:secret@dpg-example-a.oregon-postgres.render.com/avoqado_q3b_preview',
      { ...safeEnvironment, NODE_ENV: 'production' },
    ],
    [
      'missing explicit confirmation',
      'postgresql://user:secret@dpg-example-a.oregon-postgres.render.com/avoqado_q3b_preview',
      { ...safeEnvironment, Q3B_RENDER_REVIEW_SEED_CONFIRM: '' },
    ],
  ])('rejects %s', (_label, databaseUrl, environment) => {
    expect(() => assertQ3bRenderReviewSeedTarget(databaseUrl, environment)).toThrow(
      'COMMERCIAL_Q3B_RENDER_REVIEW_SEED_TARGET_REJECTED',
    )
  })

  it('defines unique, reviewable scenarios without inventing the transient ready state', () => {
    expect(Q3B_RENDER_REVIEW_SCENARIOS.map(item => item.key)).toEqual([
      'PENDING_REVIEW',
      'AWAITING_SECOND_APPROVAL',
      'REJECTED',
      'RECONCILED',
    ])
    expect(new Set(Q3B_RENDER_REVIEW_SCENARIOS.map(item => item.quoteId)).size).toBe(
      Q3B_RENDER_REVIEW_SCENARIOS.length,
    )
    expect(Q3B_RENDER_REVIEW_SCENARIOS.some(item => item.key === 'READY_TO_RECONCILE')).toBe(false)
  })

  it('pins the founder-review offer and money expectations before any preview data is written', () => {
    expect(Q3B_RENDER_REVIEW_OFFER).toMatchObject({
      code: 'Q3B_REVIEW_POS_50',
      ruleCode: 'POS_FIXED_50',
      amountMinor: 5_000n,
      cycles: 3,
    })
    expect(Q3B_RENDER_REVIEW_MAIN_SELECTIONS.map(item => item.targetCode)).toEqual([
      'POS',
      'TABLE_SERVICE_MODULE',
      'KITCHEN_DISPLAY_MODULE',
      'CFDI_MODULE',
    ])
    expect(Q3B_RENDER_REVIEW_MONEY).toEqual({
      mainCurrentTotalMinor: '78532',
      mainRenewalTotalMinor: '101616',
      speiCurrentTotalMinor: '5800',
      speiRenewalTotalMinor: '28884',
      policyDualApprovalThresholdMinor: 500_000n,
    })
  })
})
