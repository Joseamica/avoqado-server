import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(__dirname, '../../..')
const harness = path.join(__dirname, 'commercial-phase2-migration-replay-harness.cjs')
const phaseTwoTables = [
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
].sort()

describe('Commercial Phase 2 exact migration replay', () => {
  it('applies only Phase 2 over Phase 1 plus populated legacy rows without changing an existing byte', () => {
    const replay = spawnSync(process.execPath, [harness], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    })

    expect({ status: replay.status, stderr: replay.stderr }).toEqual({ status: 0, stderr: '' })
    const evidence = JSON.parse(replay.stdout)
    expect(evidence.migration).toBe('20260822090000_add_commercial_campaigns_quotes_phase2')
    expect(evidence.before).toEqual(evidence.after)
    expect(JSON.stringify(evidence.before)).toContain('legacy-pos-249')
    expect(JSON.stringify(evidence.before)).toContain('phase-one-draft')
    expect(evidence.phaseTwo.tables).toEqual(phaseTwoTables)
    expect(evidence.phaseTwo.counts).toEqual(Object.fromEntries(phaseTwoTables.map(table => [table, 0])))
    expect(evidence.phaseTwo.snapshotConstraint).toContain('commercial_quote_snapshot_is_consistent')
    expect(evidence.phaseTwo.immutableTriggers).toEqual([
      'commercial_acquisition_context_immutable',
      'commercial_campaign_claim_immutable',
      'commercial_campaign_version_immutable',
      'commercial_quote_immutable',
      'commercial_subscription_event_immutable',
    ])
  }, 130_000)
})
