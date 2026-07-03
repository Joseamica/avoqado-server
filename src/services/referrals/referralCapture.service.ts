import prisma from '@/utils/prismaClient'
import { Referral } from '@prisma/client'

/**
 * Why these four reasons and not Zod-style messages: callers (controllers
 * + TPV widget) need a stable machine-readable discriminator to drive
 * UX. The frontend maps each enum value to its own Spanish copy + CTA
 * (e.g., `EXISTING_CUSTOMER` triggers the "Forzar referido" manager
 * override flow). Free-form messages would be impossible to switch on.
 */
export type ValidationReason = 'PROGRAM_INACTIVE' | 'CODE_NOT_FOUND' | 'SELF_REFERRAL' | 'EXISTING_CUSTOMER'

export interface ValidationResult {
  valid: boolean
  reason?: ValidationReason
  referrer?: { id: string; firstName: string | null; lastName: string | null }
  /** Convenience copy of `ReferralProgramConfig.newCustomerDiscountPercent`
   *  so callers don't have to re-query the config row. */
  discountPercent?: number
}

export interface ValidateInput {
  venueId: string
  referralCode: string
  newCustomerId: string
}

/**
 * Validate a referral code presented at checkout. Returns a discriminated
 * result rather than throwing because the most common "failure" cases
 * (existing customer, self-referral) are normal UX paths, not exceptions.
 *
 * Checks are short-circuited in this order:
 *   1. Program must exist + be `active`.
 *   2. Code must resolve to a Customer in the same venue.
 *   3. The presenter (newCustomerId) cannot be the same Customer as the
 *      code's owner.
 *   4. The presenter must have zero prior Orders in this venue (the "new
 *      customer" definition for the program).
 */
export async function validateReferralCode(input: ValidateInput): Promise<ValidationResult> {
  const config = await prisma.referralProgramConfig.findUnique({
    where: { venueId: input.venueId },
    select: { active: true, newCustomerDiscountPercent: true },
  })
  if (!config || !config.active) {
    return { valid: false, reason: 'PROGRAM_INACTIVE' }
  }

  const referrer = await prisma.customer.findFirst({
    where: { venueId: input.venueId, referralCode: input.referralCode },
    select: { id: true, firstName: true, lastName: true },
  })
  if (!referrer) {
    return { valid: false, reason: 'CODE_NOT_FOUND' }
  }

  if (referrer.id === input.newCustomerId) {
    return { valid: false, reason: 'SELF_REFERRAL' }
  }

  const priorOrderCount = await prisma.order.count({
    where: { customerId: input.newCustomerId, venueId: input.venueId },
  })
  if (priorOrderCount > 0) {
    return { valid: false, reason: 'EXISTING_CUSTOMER' }
  }

  return {
    valid: true,
    referrer,
    discountPercent: Number(config.newCustomerDiscountPercent),
  }
}

export interface CaptureInput {
  venueId: string
  referralCode: string
  newCustomerId: string
  capturedByStaffVenueId: string
  /** Optional: link the pending Referral to a specific Order before
   *  payment so the qualifying-order webhook can flip the status with
   *  no extra lookup. */
  intendedOrderId?: string
}

/**
 * Resolve a client-supplied staff identifier into a valid `StaffVenue.id`
 * for this venue, returning `null` when no match exists.
 *
 * WHY: the mobile clients (TPV, Android POS, iOS POS) persist a `Staff.id`
 * (a.k.a. userId) in their secure storage, NOT the `StaffVenue` join-row id
 * that the `Referral.capturedByStaffVenueId` FK requires. Passing a raw
 * Staff.id (or anything else) straight to the insert violates the FK and
 * crashes the capture with a 500. This helper makes capture tolerant of
 * either id:
 *   1. If the value already IS a StaffVenue.id for this venue → use it.
 *   2. Else if it matches a Staff.id with a StaffVenue at this venue → map it.
 *   3. Else → null (capture still succeeds; the audit link is simply absent).
 */
export async function resolveStaffVenueId(venueId: string, candidate: string | null | undefined): Promise<string | null> {
  if (!candidate) return null

  // 1. Already a valid StaffVenue id at this venue?
  const direct = await prisma.staffVenue.findFirst({
    where: { id: candidate, venueId },
    select: { id: true },
  })
  if (direct) return direct.id

  // 2. A Staff id that has a StaffVenue at this venue?
  const byStaff = await prisma.staffVenue.findFirst({
    where: { staffId: candidate, venueId },
    select: { id: true },
  })
  if (byStaff) return byStaff.id

  // 3. Unknown identifier — don't crash the capture; just drop the link.
  return null
}

/**
 * Create a PENDING Referral row after re-running validation. We don't
 * trust the caller to have called `validateReferralCode` first — this
 * function is the only consumer-safe entrypoint that persists state.
 *
 * If validation fails, we throw with the `ValidationReason` as the
 * error message so HTTP handlers can map it to the appropriate 4xx code.
 */
export async function captureReferral(input: CaptureInput): Promise<Referral> {
  const validation = await validateReferralCode({
    venueId: input.venueId,
    referralCode: input.referralCode,
    newCustomerId: input.newCustomerId,
  })
  if (!validation.valid) {
    throw new Error(validation.reason)
  }
  const capturedByStaffVenueId = await resolveStaffVenueId(input.venueId, input.capturedByStaffVenueId)
  return prisma.referral.create({
    data: {
      venueId: input.venueId,
      referrerCustomerId: validation.referrer!.id,
      referredCustomerId: input.newCustomerId,
      status: 'PENDING',
      capturedByStaffVenueId,
      qualifyingOrderId: input.intendedOrderId,
    },
  })
}

export interface ForceOverrideInput {
  venueId: string
  referralCode: string
  existingCustomerId: string
  capturedByStaffVenueId: string
  managerStaffVenueId: string
  reason: string
}

/**
 * Manager-authorized "force this referral even though the customer
 * isn't new" path. Bypasses the EXISTING_CUSTOMER check, but NOT the
 * structural ones (code must exist, can't be a self-referral).
 *
 * Side effects:
 *   - Creates a Referral row with `forcedOverride=true` and the manager's
 *     stated reason persisted on `overrideReason`.
 *   - Writes an `ActivityLog` row tagged `REFERRAL_FORCE_OVERRIDE` with
 *     the manager and waiter ids in the JSON `data` column for audit.
 */
export async function forceOverrideReferral(input: ForceOverrideInput): Promise<Referral> {
  const referrer = await prisma.customer.findFirst({
    where: { venueId: input.venueId, referralCode: input.referralCode },
    select: { id: true },
  })
  if (!referrer) throw new Error('CODE_NOT_FOUND')
  if (referrer.id === input.existingCustomerId) throw new Error('SELF_REFERRAL')

  const capturedByStaffVenueId = await resolveStaffVenueId(input.venueId, input.capturedByStaffVenueId)
  const referral = await prisma.referral.create({
    data: {
      venueId: input.venueId,
      referrerCustomerId: referrer.id,
      referredCustomerId: input.existingCustomerId,
      status: 'PENDING',
      capturedByStaffVenueId,
      forcedOverride: true,
      overrideReason: input.reason,
    },
  })

  await prisma.activityLog.create({
    data: {
      venueId: input.venueId,
      action: 'REFERRAL_FORCE_OVERRIDE',
      entity: 'Referral',
      entityId: referral.id,
      data: {
        reason: input.reason,
        managerStaffVenueId: input.managerStaffVenueId,
        capturedByStaffVenueId: input.capturedByStaffVenueId,
        referrerCustomerId: referrer.id,
        existingCustomerId: input.existingCustomerId,
      },
    },
  })

  return referral
}

export interface ManualVoidInput {
  referralId: string
  reason: string
  staffVenueId: string
}

/**
 * Soft-void a Referral that is still PENDING.
 *
 * Why we refuse to void QUALIFIED rows: once a referral has qualified,
 * a reward coupon has already been emitted (and possibly redeemed) on
 * the referrer's account. Walking that back requires reversing the
 * discount via the refund flow, not a status flip — bare voiding would
 * leave dangling coupon state.
 */
export async function manualVoidReferral(input: ManualVoidInput): Promise<Referral> {
  const existing = await prisma.referral.findUnique({ where: { id: input.referralId } })
  if (!existing) throw new Error('Referral not found')
  if (existing.status === 'QUALIFIED') {
    throw new Error('Referral already qualified — use refund flow instead')
  }

  const updated = await prisma.referral.update({
    where: { id: input.referralId },
    data: {
      status: 'VOID',
      voidedAt: new Date(),
      voidReason: input.reason,
    },
  })

  await prisma.activityLog.create({
    data: {
      venueId: existing.venueId,
      action: 'REFERRAL_MANUAL_VOID',
      entity: 'Referral',
      entityId: input.referralId,
      data: { reason: input.reason, staffVenueId: input.staffVenueId },
    },
  })

  return updated
}
