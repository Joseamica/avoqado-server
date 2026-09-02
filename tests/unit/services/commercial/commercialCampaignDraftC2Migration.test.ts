import { readFileSync } from 'node:fs'
import path from 'node:path'

const migrationPath = path.join(process.cwd(), 'prisma/migrations/20260826170000_add_commercial_campaign_stacking_groups_v2/migration.sql')

describe('commercial campaign draft C2 migration', () => {
  it('is expand-only, preserves legacy bytes and installs the v2 XOR plus unit bound atomically', () => {
    const sql = readFileSync(migrationPath, 'utf8')

    const ordered = [
      'BEGIN;',
      "SET LOCAL lock_timeout = '5s';",
      "SET LOCAL statement_timeout = '15min';",
      'LOCK TABLE "CommercialCampaignDraft" IN ACCESS EXCLUSIVE MODE;',
      'LOCK TABLE "CommercialCampaignRuleDraft" IN ACCESS EXCLUSIVE MODE;',
      'jsonb_typeof("allowedRuleCodeGroups") IS DISTINCT FROM \'array\'',
      '"amountMinor" NOT BETWEEN 0 AND 999999999999',
      "ERRCODE = '23514'",
      "MESSAGE = 'COMMERCIAL_CAMPAIGN_C2_LEGACY_PREFLIGHT_FAILED'",
      'ADD COLUMN "stackingGroups" JSONB',
      'ALTER COLUMN "allowedRuleCodeGroups" DROP NOT NULL',
      'DROP CONSTRAINT "CommercialCampaignRuleDraft_v1_amount_int4_check"',
      'ADD CONSTRAINT "CommercialCampaignRuleDraft_amount_unit_check"',
      'ADD CONSTRAINT "CommercialCampaignDraft_stacking_storage_check"',
      'COMMIT;',
    ]
    let cursor = -1
    for (const fragment of ordered) {
      const next = sql.indexOf(fragment, cursor + 1)
      expect(next).toBeGreaterThan(cursor)
      cursor = next
    }

    expect(sql).toContain('"amountMinor" BETWEEN 0 AND 999999999999')
    expect(sql).toContain('jsonb_typeof("allowedRuleCodeGroups") = \'array\'')
    expect(sql).toContain('jsonb_typeof("stackingGroups") = \'array\'')
    expect(sql.match(/COMMERCIAL_CAMPAIGN_C2_LEGACY_PREFLIGHT_FAILED/g)).toHaveLength(1)
    expect(sql.match(/ALTER TABLE/g)?.length).toBeGreaterThanOrEqual(3)
    expect(sql).not.toMatch(/\bUPDATE\s+"CommercialCampaignDraft"/i)
    expect(sql).not.toMatch(/\bUPDATE\s+"CommercialCampaignRuleDraft"/i)
    expect(sql).not.toMatch(/jsonb_build_(array|object)|jsonb_agg|row_number\s*\(/i)
  })
})
