/**
 * Integration test: data migration backfill for
 * ReferralTierReward (flat tier{1,2,3}RewardPercent → per-tier reward rows)
 * and ReferralTierUnlock (lifetime unlock rows for every level a customer
 * has ALREADY earned, not just their current tier).
 *
 * Runs against the LIVE local DB `av-db-25` (same as
 * `referrals.integration.test.ts`) — the migration this test proves out
 * only exists in that DB, not in the isolated `av-db-25-test` DB. To run
 * THIS suite against `av-db-25`:
 *
 *   TEST_DATABASE_URL="postgresql://postgres:exitosoy777@localhost:5432/av-db-25" \
 *     npx jest --selectProjects=integration migration-backfill --testTimeout=30000
 *
 * (`npm run test:api` runs `tests/api-tests/**\/*.api.test.ts` — a DIFFERENT
 * jest project. This file lives under `tests/integration/`, which is picked
 * up by the `integration` jest project — run it with `npm run test:integration`
 * or the direct `--selectProjects=integration` invocation above.)
 *
 * SQL-under-test lives in `prisma/migrations/<ts>_referral_backfill/migration.sql`
 * — this file is READ from disk and executed verbatim so the test proves the
 * actual migration file, not a hand-copied stand-in.
 *
 * Repeatability on a SHARED dev DB: the raw migration SQL has no scoping
 * WHERE clause (by design — it's a one-time backfill meant to run exactly
 * once per environment via `prisma migrate deploy`). Naively re-executing it
 * against a shared DB that may already contain OTHER real
 * ReferralProgramConfig / Customer rows would either duplicate reward rows
 * (harmless but pollutes the table) or — worse — collide with the
 * `ReferralTierUnlock` `@@unique([customerId, tierLevel])` constraint for a
 * real customer already unlocked by an earlier real `migrate dev` run,
 * aborting the whole multi-row INSERT (including our own fixture rows).
 *
 * To keep this test safely repeatable without ever touching real data, we
 * execute the file's exact SQL text with one addition: an extra `AND`/`WHERE`
 * clause scoping each statement to OUR OWN fixture ids. This does not change
 * the file's logic (columns, CASE mapping, tier-cascade condition) — it only
 * limits the blast radius of the TEST's re-execution. The actual migration
 * file applied via `prisma migrate dev`/`migrate deploy` runs unscoped, as
 * authored.
 */

import fs from 'fs'
import path from 'path'
import prisma from '@/utils/prismaClient'

const MIGRATIONS_DIR = path.join(__dirname, '../../../prisma/migrations')

/** Locate the backfill migration folder created in Step 3 and read its SQL. */
function readBackfillMigrationSql(): string {
  const dir = fs.readdirSync(MIGRATIONS_DIR).find(name => name.endsWith('_referral_backfill'))
  if (!dir) {
    throw new Error(
      `No migration folder ending in "_referral_backfill" found under ${MIGRATIONS_DIR}. ` +
        `Run: npx prisma migrate dev --create-only --name referral_backfill`,
    )
  }
  const sqlPath = path.join(MIGRATIONS_DIR, dir, 'migration.sql')
  return fs.readFileSync(sqlPath, 'utf-8')
}

/**
 * Split the migration file into individual statements. Strips full-line
 * `-- comment` lines FIRST — one of the file's own header comments contains
 * a literal `;` ("no hay cuid v1 real; 'c' + 24 hex...") which would
 * otherwise fool a naive `;`-split into cutting a statement in half.
 */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')

  return withoutComments
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * Executes the real migration.sql, scoped to a single config + a single
 * customer so it never touches pre-existing rows in the shared dev DB (see
 * file header). Proves the SAME SQL shape/columns/logic as the file; only
 * adds a scoping predicate.
 */
async function runBackfillSql(opts: { configId?: string; customerId?: string }) {
  const sql = readBackfillMigrationSql()
  const statements = splitStatements(sql)

  for (const statement of statements) {
    if (/INSERT INTO "ReferralTierReward"/.test(statement) && opts.configId) {
      // No WHERE clause exists in the source statement — add one.
      const scoped = `${statement} WHERE c."id" = '${opts.configId}'`
      await prisma.$executeRawUnsafe(scoped)
    } else if (/INSERT INTO "ReferralTierUnlock"/.test(statement) && opts.customerId) {
      // A WHERE clause already exists — extend it with AND.
      const scoped = statement.replace(
        /WHERE cu\."referralTier" IS NOT NULL/,
        `WHERE cu."referralTier" IS NOT NULL AND cu."id" = '${opts.customerId}'`,
      )
      await prisma.$executeRawUnsafe(scoped)
    }
  }
}

describe('Referral backfill migration — ReferralTierReward + ReferralTierUnlock', () => {
  let venueId: string
  let configId: string
  let tier2CustomerId: string
  let tier3CustomerId: string
  let noTierCustomerId: string
  let tier1RepeatCustomerId: string

  async function cleanup() {
    await prisma.referralTierUnlock.deleteMany({
      where: {
        customerId: { in: [tier2CustomerId, tier3CustomerId, noTierCustomerId, tier1RepeatCustomerId].filter(Boolean) },
      },
    })
    await prisma.referralTierReward.deleteMany({ where: { configId } })
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.referralProgramConfig.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`

    const org = await prisma.organization.create({
      data: {
        name: `Referral Backfill Test Org ${suffix}`,
        email: `referral-backfill-${suffix}@test.com`,
        phone: '5550000001',
      },
    })

    const venue = await prisma.venue.create({
      data: {
        name: `Referral Backfill Test Venue ${suffix}`,
        slug: `referral-backfill-test-${suffix}`,
        organizationId: org.id,
      },
    })
    venueId = venue.id

    const config = await prisma.referralProgramConfig.create({
      data: {
        venueId,
        tier1RewardPercent: 15,
        tier2RewardPercent: 20,
        tier3RewardPercent: 25,
      },
    })
    configId = config.id

    const tier2Customer = await prisma.customer.create({
      data: { venueId, firstName: 'Tier2', lastName: 'Backfill', phone: `55900${suffix}`.slice(0, 10), referralTier: 'TIER_2' },
    })
    tier2CustomerId = tier2Customer.id

    const tier3Customer = await prisma.customer.create({
      data: { venueId, firstName: 'Tier3', lastName: 'Backfill', phone: `55901${suffix}`.slice(0, 10), referralTier: 'TIER_3' },
    })
    tier3CustomerId = tier3Customer.id

    const noTierCustomer = await prisma.customer.create({
      data: { venueId, firstName: 'NoTier', lastName: 'Backfill', phone: `55902${suffix}`.slice(0, 10) },
    })
    noTierCustomerId = noTierCustomer.id

    const tier1RepeatCustomer = await prisma.customer.create({
      data: { venueId, firstName: 'Tier1Repeat', lastName: 'Backfill', phone: `55903${suffix}`.slice(0, 10), referralTier: 'TIER_1' },
    })
    tier1RepeatCustomerId = tier1RepeatCustomer.id
  })

  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  // 1. NEW FEATURE TESTS
  it('backfills 3 tier rewards per config from flat fields', async () => {
    await runBackfillSql({ configId })

    const rewards = await prisma.referralTierReward.findMany({ where: { configId } })
    expect(rewards).toHaveLength(3)
    expect(rewards.find(r => r.tierLevel === 1)).toMatchObject({
      rewardType: 'PERCENT_COUPON',
      rewardPercent: expect.anything(),
    })
    expect(Number(rewards.find(r => r.tierLevel === 1)!.rewardPercent)).toBe(15)
    expect(Number(rewards.find(r => r.tierLevel === 2)!.rewardPercent)).toBe(20)
    expect(Number(rewards.find(r => r.tierLevel === 3)!.rewardPercent)).toBe(25)
    rewards.forEach(r => {
      expect(r.recurrence).toBe('ONE_TIME')
      expect(r.rewardQuantity).toBe(1)
      expect(r.active).toBe(true)
    })
  })

  it('backfills tier-unlock rows for ALL earned levels, not just current', async () => {
    await runBackfillSql({ customerId: tier2CustomerId })

    const unlocks = await prisma.referralTierUnlock.findMany({ where: { customerId: tier2CustomerId } })
    expect(unlocks.map(u => u.tierLevel).sort()).toEqual([1, 2]) // TIER_2 => niveles 1 y 2
  })

  it('backfills all 3 levels for a TIER_3 customer', async () => {
    await runBackfillSql({ customerId: tier3CustomerId })

    const unlocks = await prisma.referralTierUnlock.findMany({ where: { customerId: tier3CustomerId } })
    expect(unlocks.map(u => u.tierLevel).sort()).toEqual([1, 2, 3])
  })

  // 2. REGRESSION / EDGE-CASE TESTS
  it('does NOT create unlock rows for a customer with no referralTier', async () => {
    await runBackfillSql({ customerId: noTierCustomerId })

    const unlocks = await prisma.referralTierUnlock.findMany({ where: { customerId: noTierCustomerId } })
    expect(unlocks).toHaveLength(0)
  })

  it('is a lifetime, per-level guard: re-running the unlock backfill for an already-unlocked customer throws (unique constraint)', async () => {
    // Self-contained: run once (should succeed), then run again for the SAME
    // customer — the @@unique([customerId, tierLevel]) guard must reject the
    // repeat, proving "a level unlocks once, for life" holds even under a
    // second backfill pass.
    await runBackfillSql({ customerId: tier1RepeatCustomerId })
    const firstPass = await prisma.referralTierUnlock.findMany({ where: { customerId: tier1RepeatCustomerId } })
    expect(firstPass.map(u => u.tierLevel)).toEqual([1])

    await expect(runBackfillSql({ customerId: tier1RepeatCustomerId })).rejects.toThrow()
  })
})
