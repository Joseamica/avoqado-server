import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { generateReferralCode } from './referralCode.service'

/**
 * Inputs accepted by `activateReferralProgram`. Optional template /
 * prefix fields fall back to schema defaults or runtime derivation
 * (e.g., `codePrefix` defaults to the venue's slug).
 */
export interface ActivateInput {
  venueId: string
  newCustomerDiscountPercent: number
  tier1ReferralsRequired: number
  tier1RewardPercent: number
  tier2ReferralsRequired: number
  tier2RewardPercent: number
  tier3ReferralsRequired: number
  tier3RewardPercent: number
  rewardCouponExpiryDays: number
  codePrefix?: string
  welcomeMessageTemplate?: string
  tierUpMessageTemplate?: string
}

/**
 * Shared validator for activation and partial updates.
 *
 *   - All numeric fields must be non-negative.
 *   - Tier-referral counts must be strictly ascending (t1 < t2 < t3).
 *     Only the pairs actually present on the patch are checked, so a
 *     partial update is free to touch only one tier.
 */
function validateConfig(input: Partial<ActivateInput>): void {
  const numericFields: (keyof ActivateInput)[] = [
    'newCustomerDiscountPercent',
    'tier1ReferralsRequired',
    'tier1RewardPercent',
    'tier2ReferralsRequired',
    'tier2RewardPercent',
    'tier3ReferralsRequired',
    'tier3RewardPercent',
    'rewardCouponExpiryDays',
  ]
  for (const f of numericFields) {
    const v = input[f]
    if (v !== undefined && typeof v === 'number' && v < 0) {
      throw new Error(`Field ${f} must be non-negative`)
    }
  }
  const t1r = input.tier1ReferralsRequired
  const t2r = input.tier2ReferralsRequired
  const t3r = input.tier3ReferralsRequired
  if (t1r !== undefined && t2r !== undefined && t2r <= t1r) {
    throw new Error('Tier requirements must be ascending: tier2 > tier1')
  }
  if (t2r !== undefined && t3r !== undefined && t3r <= t2r) {
    throw new Error('Tier requirements must be ascending: tier3 > tier2')
  }
}

/**
 * Compose a display name from Customer.firstName / lastName.
 * Returns null if both are absent so the code generator can fall back
 * to its ANON sentinel.
 */
function composeName(firstName: string | null | undefined, lastName: string | null | undefined): string | null {
  const a = (firstName ?? '').trim()
  const b = (lastName ?? '').trim()
  const joined = `${a} ${b}`.trim()
  return joined.length > 0 ? joined : null
}

/**
 * Activate (or re-activate) the referral program for a venue.
 *
 * Side effects, in order:
 *   1. In a FAST transaction: upsert the `ReferralProgramConfig` row
 *      (`active=true`, `activatedAt=now`) + write the `REFERRAL_PROGRAM_ACTIVATED`
 *      audit log. This is sub-second regardless of venue size.
 *   2. AFTER the transaction commits: kick off `backfillLegacyReferralCodes`
 *      as a background task (fire-and-forget). It assigns a `referralCode` to
 *      every existing customer who lacks one.
 *
 * ⚠️ WHY THE BACKFILL IS NOT IN THE TRANSACTION (production incident 2026-05-29):
 * The original version looped over every legacy customer (one collision-checked
 * code generation + one update each) INSIDE a single interactive `$transaction`.
 * Prisma interactive transactions have a 5s default timeout. A production venue
 * with enough customers blew past 5000ms → "Transaction already closed" → 500,
 * and the whole activation rolled back (config never saved). Moving the backfill
 * out of the transaction makes activation O(1) and unbreakable at any venue size.
 *
 * The backfill is idempotent (only touches `referralCode: null` rows) and
 * non-critical: new customers get codes via the creation hook, and any customer
 * still lacking a code shows the "Activar código" affordance in CustomerDetail.
 * So losing the backfill to a process restart is recoverable, never corrupting.
 */
export async function activateReferralProgram(input: ActivateInput): Promise<void> {
  validateConfig(input)

  // Step 1 — atomic, fast: config + audit log only. No per-customer work here.
  const config = await prisma.$transaction(async (tx: any) => {
    const cfg = await tx.referralProgramConfig.upsert({
      where: { venueId: input.venueId },
      create: {
        venueId: input.venueId,
        active: true,
        activatedAt: new Date(),
        newCustomerDiscountPercent: input.newCustomerDiscountPercent,
        tier1ReferralsRequired: input.tier1ReferralsRequired,
        tier1RewardPercent: input.tier1RewardPercent,
        tier2ReferralsRequired: input.tier2ReferralsRequired,
        tier2RewardPercent: input.tier2RewardPercent,
        tier3ReferralsRequired: input.tier3ReferralsRequired,
        tier3RewardPercent: input.tier3RewardPercent,
        rewardCouponExpiryDays: input.rewardCouponExpiryDays,
        codePrefix: input.codePrefix,
        welcomeMessageTemplate: input.welcomeMessageTemplate,
        tierUpMessageTemplate: input.tierUpMessageTemplate,
      },
      update: {
        active: true,
        activatedAt: new Date(),
        newCustomerDiscountPercent: input.newCustomerDiscountPercent,
        tier1ReferralsRequired: input.tier1ReferralsRequired,
        tier1RewardPercent: input.tier1RewardPercent,
        tier2ReferralsRequired: input.tier2ReferralsRequired,
        tier2RewardPercent: input.tier2RewardPercent,
        tier3ReferralsRequired: input.tier3ReferralsRequired,
        tier3RewardPercent: input.tier3RewardPercent,
        rewardCouponExpiryDays: input.rewardCouponExpiryDays,
        codePrefix: input.codePrefix,
      },
    })

    await tx.activityLog.create({
      data: {
        // `staffId` is intentionally null — activation is a venue-level event.
        staffId: null,
        venueId: input.venueId,
        action: 'REFERRAL_PROGRAM_ACTIVATED',
        entity: 'ReferralProgramConfig',
        entityId: cfg.id,
        data: { codePrefixUsed: cfg.codePrefix ?? null, backfillScheduled: true },
      },
    })

    return cfg
  })

  // Step 2 — resolve the prefix (cheap) and fire the backfill in the background.
  let venuePrefix: string | null | undefined = config.codePrefix
  if (!venuePrefix) {
    const venue = await prisma.venue.findUnique({
      where: { id: input.venueId },
      select: { slug: true },
    })
    venuePrefix = venue?.slug ?? input.venueId.slice(-8)
  }

  // Fire-and-forget: activation returns immediately; codes populate in the
  // background. NOT awaited so a large venue can never time out the request.
  void backfillLegacyReferralCodes(input.venueId, venuePrefix as string).catch(err => {
    logger.error('[referral] legacy code backfill failed', { venueId: input.venueId, err })
  })
}

/**
 * Assign a `referralCode` to every customer of a venue that lacks one.
 *
 * Runs OUTSIDE any wrapping transaction, in bounded batches, so it scales to
 * venues of any size without hitting the interactive-transaction timeout.
 * Idempotent: each pass only selects `referralCode: null` rows, and rows it
 * updates drop out of the next batch automatically. Safe to call repeatedly.
 *
 * Exported so it can be tested in isolation and re-run as a recovery step.
 */
export async function backfillLegacyReferralCodes(venueId: string, venuePrefix: string): Promise<number> {
  const BATCH_SIZE = 200
  let processed = 0

  // Loop draining null-code customers. Each update flips a row from null →
  // a code, so it leaves the `referralCode: null` working set on the next find.

  while (true) {
    const batch = await prisma.customer.findMany({
      where: { venueId, referralCode: null },
      select: { id: true, firstName: true, lastName: true },
      take: BATCH_SIZE,
    })
    if (batch.length === 0) break

    for (const c of batch) {
      const code = await generateReferralCode({
        venueId,
        venuePrefix,
        customerName: composeName(c.firstName, c.lastName),
      })
      await prisma.customer.update({ where: { id: c.id }, data: { referralCode: code } })
      processed++
    }
  }

  if (processed > 0) {
    logger.info('[referral] legacy code backfill complete', { venueId, processed })
  }
  return processed
}

export interface DeactivateInput {
  venueId: string
  reason: string
}

/**
 * Soft-deactivate the program: flips `active=false` and records an
 * `ActivityLog` entry. The config row, customers' codes, and existing
 * referral records are preserved so re-activation is non-destructive.
 */
export async function deactivateReferralProgram(input: DeactivateInput): Promise<void> {
  await prisma.referralProgramConfig.update({
    where: { venueId: input.venueId },
    data: { active: false },
  })
  await prisma.activityLog.create({
    data: {
      staffId: null,
      venueId: input.venueId,
      action: 'REFERRAL_PROGRAM_DEACTIVATED',
      entity: 'ReferralProgramConfig',
      data: { reason: input.reason },
    },
  })
}

export interface UpdateConfigInput {
  venueId: string
  patch: Partial<ActivateInput>
}

/**
 * Partial update of a `ReferralProgramConfig`. The patch is validated
 * with the same ascending-tier and non-negative rules as activation.
 */
export async function updateReferralConfig(input: UpdateConfigInput): Promise<void> {
  validateConfig(input.patch)
  await prisma.referralProgramConfig.update({
    where: { venueId: input.venueId },
    data: input.patch,
  })
}
