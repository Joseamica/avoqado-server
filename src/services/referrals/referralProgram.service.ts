import prisma from '@/utils/prismaClient'
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
 *   1. Upsert the `ReferralProgramConfig` row, setting `active=true`
 *      and `activatedAt=now`.
 *   2. Backfill `referralCode` for every existing customer in that
 *      venue who doesn't have one yet (idempotent on re-runs).
 *   3. Write an `ActivityLog` entry tagged `REFERRAL_PROGRAM_ACTIVATED`
 *      with the count of legacy customers migrated.
 *
 * Everything runs in a single `$transaction` — if the audit log write
 * fails, the config and code backfills are rolled back as well.
 */
export async function activateReferralProgram(input: ActivateInput): Promise<void> {
  validateConfig(input)
  await prisma.$transaction(async (tx: any) => {
    const config = await tx.referralProgramConfig.upsert({
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

    let venuePrefix: string | null | undefined = config.codePrefix
    if (!venuePrefix) {
      const venue = await tx.venue.findUnique({
        where: { id: input.venueId },
        select: { slug: true },
      })
      venuePrefix = venue?.slug ?? input.venueId.slice(-8)
    }

    const legacyCustomers = await tx.customer.findMany({
      where: { venueId: input.venueId, referralCode: null },
      select: { id: true, firstName: true, lastName: true },
    })
    for (const c of legacyCustomers) {
      const code = await generateReferralCode({
        venueId: input.venueId,
        venuePrefix: venuePrefix as string,
        customerName: composeName(c.firstName, c.lastName),
      })
      await tx.customer.update({
        where: { id: c.id },
        data: { referralCode: code },
      })
    }

    await tx.activityLog.create({
      data: {
        // `staffId` is intentionally null — activation is a venue-level
        // event, not tied to a specific staff member at the moment of
        // calling. Callers that want attribution can pass it through a
        // future enhancement.
        staffId: null,
        venueId: input.venueId,
        action: 'REFERRAL_PROGRAM_ACTIVATED',
        entity: 'ReferralProgramConfig',
        entityId: config.id,
        data: {
          legacyCustomersMigrated: legacyCustomers.length,
          codePrefixUsed: venuePrefix,
        },
      },
    })
  })
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
