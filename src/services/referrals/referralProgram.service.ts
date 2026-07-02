import { Prisma, ReferralRewardType, ReferralRewardRecurrence } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { generateReferralCode } from './referralCode.service'

/**
 * One configured reward for one tier level. Several rewards per tier are
 * allowed (e.g. Tier 3 = 25% coupon + a free product), so callers send an
 * array rather than one row per tier. Persisted to `ReferralTierReward`
 * (see spec §4.2) — never to the legacy flat `tier{N}RewardPercent` columns.
 */
export interface TierRewardInput {
  tierLevel: 1 | 2 | 3
  rewardType: ReferralRewardType
  recurrence?: ReferralRewardRecurrence
  rewardPercent?: number
  rewardProductId?: string
  rewardQuantity?: number
}

/**
 * Inputs accepted by `activateReferralProgram`. Optional template /
 * prefix fields fall back to schema defaults or runtime derivation
 * (e.g., `codePrefix` defaults to the venue's slug).
 */
export interface ActivateInput {
  venueId: string
  newCustomerDiscountPercent: number
  tier1ReferralsRequired: number
  tier2ReferralsRequired: number
  tier3ReferralsRequired: number
  rewardCouponExpiryDays: number
  codePrefix?: string
  welcomeMessageTemplate?: string
  tierUpMessageTemplate?: string
  /**
   * Per-tier reward configuration (spec §4.2/§4.5). Optional so a caller
   * that only wants to touch thresholds/messaging need not resend it —
   * omitting it (or passing `[]`) leaves existing `ReferralTierReward`
   * rows untouched.
   */
  tiers?: TierRewardInput[]
  /**
   * @deprecated Superseded by `tiers` / `ReferralTierReward`. Kept ONLY so
   * older call sites still type-check during the migration window — the
   * service NEVER writes these to `ReferralProgramConfig` anymore (the
   * columns are dead per spec §4.5, retired in a later cleanup migration).
   */
  tier1RewardPercent?: number
  /** @deprecated see `tier1RewardPercent` */
  tier2RewardPercent?: number
  /** @deprecated see `tier1RewardPercent` */
  tier3RewardPercent?: number
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
    'tier2ReferralsRequired',
    'tier3ReferralsRequired',
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
 * Business-rule validation for per-tier reward configuration (spec §7):
 *
 *   - `FREE_PRODUCT` must reference a product that exists AND belongs to
 *     the SAME venue (the FK on `ReferralTierReward.rewardProductId` does
 *     NOT enforce this — Codex [P2] — so the service must).
 *   - `PERCENT_COUPON` / `PERMANENT_DISCOUNT` require a non-negative
 *     `rewardPercent`.
 *
 * Runs to completion validating every tier BEFORE any DB write, so a bad
 * entry anywhere in the batch aborts the whole call with nothing persisted.
 */
async function validateTierRewards(venueId: string, tiers: TierRewardInput[]): Promise<void> {
  for (const t of tiers) {
    if (t.rewardType === ReferralRewardType.FREE_PRODUCT) {
      // Guard BEFORE the query: Prisma's `findFirst` silently IGNORES an
      // `undefined` filter value, so `{ where: { id: undefined, venueId } }`
      // would match an arbitrary product in the venue instead of failing —
      // letting a FREE_PRODUCT row persist with `rewardProductId: null`.
      if (!t.rewardProductId) throw new Error('PRODUCTO_NO_PERTENECE_AL_VENUE')
      const product = await prisma.product.findFirst({
        where: { id: t.rewardProductId, venueId },
        select: { id: true },
      })
      if (!product) throw new Error('PRODUCTO_NO_PERTENECE_AL_VENUE')
    }
    if (
      (t.rewardType === ReferralRewardType.PERCENT_COUPON || t.rewardType === ReferralRewardType.PERMANENT_DISCOUNT) &&
      (t.rewardPercent == null || Number(t.rewardPercent) < 0)
    ) {
      throw new Error('PORCENTAJE_INVALIDO')
    }
  }
}

/**
 * Persist per-tier reward configuration to `ReferralTierReward`.
 *
 * Versioning rule (spec §4.2, binding): a tier edit NEVER physically
 * deletes existing rows — `ReferralRewardGrant.tierRewardId` is NON-NULL
 * with `onDelete: Restrict`, so a delete would either orphan issued grants
 * or fail outright. Instead, for every tier level present in `tiers`:
 *   1. Deactivate (`active=false`) all currently-active rows for that level.
 *   2. Create a fresh row for each reward supplied for that level.
 *
 * Tier levels NOT present in `tiers` are left completely untouched, so a
 * caller can edit just one level per call (matches the existing partial-
 * update semantics of `updateReferralConfig`).
 *
 * The whole thing runs inside ONE `$transaction`: a transient DB blip
 * (this repo has documented P1001/P2024 blips) between a tier's `updateMany`
 * and its `create`(s) would otherwise leave that tier with ZERO active
 * rewards. Both callers (`activateReferralProgram`, `updateReferralConfig`)
 * invoke this OUTSIDE any surrounding transaction, so nesting `$transaction`
 * here is safe (no interactive-transaction-inside-transaction issue).
 */
async function persistTierRewards(configId: string, tiers: TierRewardInput[]): Promise<void> {
  const rewardsByTier = new Map<number, TierRewardInput[]>()
  for (const t of tiers) {
    const bucket = rewardsByTier.get(t.tierLevel) ?? []
    bucket.push(t)
    rewardsByTier.set(t.tierLevel, bucket)
  }

  await prisma.$transaction(async (tx: any) => {
    for (const [tierLevel, rewards] of rewardsByTier) {
      await tx.referralTierReward.updateMany({
        where: { configId, tierLevel, active: true },
        data: { active: false },
      })
      for (const reward of rewards) {
        await tx.referralTierReward.create({
          data: {
            configId,
            tierLevel: reward.tierLevel,
            rewardType: reward.rewardType,
            recurrence: reward.recurrence ?? ReferralRewardRecurrence.ONE_TIME,
            rewardPercent: reward.rewardPercent != null ? new Prisma.Decimal(reward.rewardPercent) : null,
            rewardProductId: reward.rewardProductId ?? null,
            rewardQuantity: reward.rewardQuantity ?? 1,
          },
        })
      }
    }
  })
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
  const tiers = input.tiers ?? []
  if (tiers.length > 0) {
    await validateTierRewards(input.venueId, tiers)
  }

  // Step 1 — atomic, fast: config + audit log only. No per-customer work here.
  // Note: the legacy tier{N}RewardPercent columns are intentionally NOT
  // written anymore — reward config lives in `ReferralTierReward` (below).
  const config = await prisma.$transaction(async (tx: any) => {
    const cfg = await tx.referralProgramConfig.upsert({
      where: { venueId: input.venueId },
      create: {
        venueId: input.venueId,
        active: true,
        activatedAt: new Date(),
        newCustomerDiscountPercent: input.newCustomerDiscountPercent,
        tier1ReferralsRequired: input.tier1ReferralsRequired,
        tier2ReferralsRequired: input.tier2ReferralsRequired,
        tier3ReferralsRequired: input.tier3ReferralsRequired,
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
        tier2ReferralsRequired: input.tier2ReferralsRequired,
        tier3ReferralsRequired: input.tier3ReferralsRequired,
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

  if (tiers.length > 0) {
    await persistTierRewards(config.id, tiers)
  }

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
  /**
   * Scalar config fields (thresholds, templates, etc). Optional — a caller
   * that only wants to edit `tiers` need not send a patch at all.
   */
  patch?: Partial<ActivateInput>
  /**
   * Per-tier reward configuration (spec §4.2/§4.5). Accepted at the top
   * level (not nested in `patch`) so a tiers-only call is a plain
   * `{ venueId, tiers }`. If both `patch.tiers` and this are given, the
   * top-level `tiers` wins.
   */
  tiers?: TierRewardInput[]
}

/**
 * Partial update of a `ReferralProgramConfig`. The scalar patch is
 * validated with the same ascending-tier and non-negative rules as
 * activation; `tiers` (if present) go through `validateTierRewards` and
 * are persisted to `ReferralTierReward` via the versioning rule in
 * `persistTierRewards` — NEVER written to the legacy flat columns.
 */
export async function updateReferralConfig(input: UpdateConfigInput): Promise<void> {
  const patch = input.patch ?? {}
  validateConfig(patch)

  const tiers = input.tiers ?? patch.tiers ?? []
  if (tiers.length > 0) {
    await validateTierRewards(input.venueId, tiers)
  }

  // Legacy flat reward-percent fields (deprecated, dead columns) and
  // `tiers` (handled separately below) are stripped before the scalar
  // update — the service must never write them (spec §4.5).
  const { tier1RewardPercent: _t1, tier2RewardPercent: _t2, tier3RewardPercent: _t3, tiers: _tiersInPatch, ...cleanPatch } = patch

  if (Object.keys(cleanPatch).length > 0) {
    await prisma.referralProgramConfig.update({
      where: { venueId: input.venueId },
      data: cleanPatch,
    })
  }

  if (tiers.length > 0) {
    const config = await prisma.referralProgramConfig.findUnique({
      where: { venueId: input.venueId },
      select: { id: true },
    })
    if (!config) throw new Error('REFERRAL_PROGRAM_NOT_CONFIGURED')
    await persistTierRewards(config.id, tiers)
  }
}
