import prisma from '@/utils/prismaClient'

const expectedTables = [
  'CommercialCampaignDraft',
  'CommercialCampaignRuleDraft',
  'CommercialCampaignVersion',
  'CommercialCampaignActivation',
  'CommercialCampaignClaim',
  'CommercialAcquisitionContext',
  'CommercialQuote',
  'CommercialQuoteAcceptance',
  'CommercialStripeOperation',
  'CommercialSubscriptionEvent',
]

describe('Commercial campaigns and quotes Phase 2 migration', () => {
  afterAll(async () => prisma.$disconnect())

  it('adds the separate campaign, acquisition, quote and Stripe authority tables', async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${expectedTables}::text[])
      ORDER BY table_name
    `

    expect(tables.map(row => row.table_name)).toEqual([...expectedTables].sort())
  })

  it('pins quotes to exact publications and keeps acceptance/Stripe idempotency separate', async () => {
    const uniqueIndexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY(ARRAY[
          'CommercialQuoteAcceptance_quoteId_key',
          'CommercialQuoteAcceptance_idempotencyKey_key',
          'CommercialStripeOperation_idempotencyKey_key',
          'CommercialSubscriptionEvent_stripeEventId_key',
          'CommercialCampaignClaim_tokenHash_key'
        ]::text[])
      ORDER BY indexname
    `
    const foreignKeys = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname
      FROM pg_constraint
      WHERE conname = ANY(ARRAY[
        'CommercialQuote_catalogPublicationId_fkey',
        'CommercialQuote_campaignVersionId_fkey',
        'CommercialQuote_acquisitionContextId_fkey',
        'CommercialCampaignClaim_campaignVersionId_campaignCode_fkey'
      ]::text[])
      ORDER BY conname
    `

    expect(uniqueIndexes.map(row => row.indexname)).toEqual([
      'CommercialCampaignClaim_tokenHash_key',
      'CommercialQuoteAcceptance_idempotencyKey_key',
      'CommercialQuoteAcceptance_quoteId_key',
      'CommercialStripeOperation_idempotencyKey_key',
      'CommercialSubscriptionEvent_stripeEventId_key',
    ])
    expect(foreignKeys.map(row => row.conname)).toEqual([
      'CommercialCampaignClaim_campaignVersionId_campaignCode_fkey',
      'CommercialQuote_acquisitionContextId_fkey',
      'CommercialQuote_campaignVersionId_fkey',
      'CommercialQuote_catalogPublicationId_fkey',
    ])
  })

  it('enforces immutable campaign versions and quote bodies at the database boundary', async () => {
    const triggers = await prisma.$queryRaw<Array<{ table_name: string; trigger_name: string }>>`
      SELECT c.relname AS table_name, t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal
        AND t.tgname IN (
          'commercial_campaign_version_immutable',
          'commercial_campaign_claim_immutable',
          'commercial_acquisition_context_immutable',
          'commercial_quote_immutable',
          'commercial_subscription_event_immutable'
        )
      ORDER BY t.tgname
    `

    expect(triggers).toEqual([
      { table_name: 'CommercialAcquisitionContext', trigger_name: 'commercial_acquisition_context_immutable' },
      { table_name: 'CommercialCampaignClaim', trigger_name: 'commercial_campaign_claim_immutable' },
      { table_name: 'CommercialCampaignVersion', trigger_name: 'commercial_campaign_version_immutable' },
      { table_name: 'CommercialQuote', trigger_name: 'commercial_quote_immutable' },
      { table_name: 'CommercialSubscriptionEvent', trigger_name: 'commercial_subscription_event_immutable' },
    ])
  })

  it('installs exact money, time, rule and state constraints', async () => {
    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname
      FROM pg_constraint
      WHERE conname = ANY(ARRAY[
        'CommercialCampaignDraft_window_check',
        'CommercialCampaignRuleDraft_adjustment_check',
        'CommercialCampaignRuleDraft_cycles_check',
        'CommercialCampaignClaim_expiry_check',
        'CommercialCampaignClaim_channel_check',
        'CommercialAcquisitionContext_expiry_check',
        'CommercialQuote_window_check',
        'CommercialQuote_totals_check',
        'CommercialQuote_snapshot_totals_check',
        'CommercialQuoteAcceptance_revision_check'
      ]::text[])
      ORDER BY conname
    `

    expect(constraints).toHaveLength(10)
  })

  it('binds the quote CHECK to a fail-closed line, IVA and aggregate validator', async () => {
    const constraints = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'CommercialQuote_snapshot_totals_check'
    `

    expect(constraints).toHaveLength(1)
    expect(constraints[0].definition).toContain('commercial_quote_snapshot_is_consistent')
    expect(constraints[0].definition).toMatch(/IS TRUE/i)
  })
})
