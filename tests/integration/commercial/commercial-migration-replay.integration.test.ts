import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(__dirname, '../../..')
const harness = path.join(__dirname, 'commercial-migration-replay-harness.cjs')
const commercialTables = [
  'CommercialDraft',
  'CommercialProductDraft',
  'CommercialPricebookDraft',
  'CommercialPriceDraft',
  'CommercialBundleDraft',
  'CommercialBundleItemDraft',
  'CommercialFeatureBindingDraft',
  'CommercialPublication',
  'CommercialPublicationActivation',
  'CommercialPublicationOutbox',
].sort()

describe('Commercial Phase 1 exact migration replay', () => {
  it('applies to empty and legacy-populated schemas without changing a legacy byte', () => {
    const replay = spawnSync(process.execPath, [harness], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: 120_000,
    })

    expect({ status: replay.status, stderr: replay.stderr }).toEqual({ status: 0, stderr: '' })
    const evidence = JSON.parse(replay.stdout)
    expect(evidence.database).toMatchObject({ host: expect.stringMatching(/^(localhost|127\.0\.0\.1)$/) })
    expect(evidence.database.pathname).toMatch(/^\/avoqado_/)
    expect(evidence.migration).toBe('20260822050000_add_commercial_catalog_phase1')
    expect(evidence.empty.before).toBe(evidence.empty.after)
    expect(evidence.legacy.before).toBe(evidence.legacy.after)
    expect(evidence.legacy.before).toContain('POS_CORE')
    expect(evidence.legacy.before).toContain('PREMIUM')
    expect(evidence.legacy.before).toContain('legacy-sku-pos')

    for (const scenario of [evidence.empty, evidence.legacy]) {
      expect(scenario.commercial.tables).toEqual(commercialTables)
      expect(scenario.commercial.counts).toEqual(Object.fromEntries(commercialTables.map(table => [table, 0])))
      expect(scenario.commercial.taxConstraint).toEqual(expect.stringContaining('amount > (0)::numeric'))
      expect(scenario.commercial.taxConstraint).toEqual(expect.stringContaining('"taxBehavior" = \'EXCLUSIVE\''))
      expect(scenario.commercial.taxConstraint).toEqual(expect.stringContaining('amount = (0)::numeric'))
      expect(scenario.commercial.taxConstraint).toEqual(expect.stringContaining('"taxBehavior" = \'NOT_APPLICABLE\''))
      expect(scenario.commercial.bundleQuantityConstraint).toEqual(expect.stringContaining('quantity = 1'))
    }
  }, 130_000)
})
