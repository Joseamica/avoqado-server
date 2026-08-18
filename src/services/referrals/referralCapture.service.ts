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

/**
 * Spanish copy for each machine reason. The enum stays the discriminator the
 * clients switch on (never remove it — dashboard/TPV/Android/iOS map it to
 * their own CTA); this is the sentence a cashier actually reads, so the
 * clients no longer each have to invent their own wording and drift apart.
 */
export const VALIDATION_REASON_MESSAGE_ES: Record<ValidationReason, string> = {
  PROGRAM_INACTIVE: 'El programa de referidos no está activo en esta sucursal.',
  CODE_NOT_FOUND: 'No encontramos ese código de referido en esta sucursal.',
  SELF_REFERRAL: 'Un cliente no puede referirse a sí mismo.',
  EXISTING_CUSTOMER: 'Este cliente ya tiene una compra pagada aquí, así que no cuenta como referido nuevo.',
}

export interface ValidationResult {
  valid: boolean
  reason?: ValidationReason
  /** Spanish sentence for `reason` — what the cashier reads. */
  message?: string
  referrer?: { id: string; firstName: string | null; lastName: string | null }
  /** Convenience copy of `ReferralProgramConfig.newCustomerDiscountPercent`
   *  so callers don't have to re-query the config row. */
  discountPercent?: number
}

export interface ValidateInput {
  venueId: string
  referralCode: string
  newCustomerId: string
  /**
   * The order this very checkout is creating, when the caller already knows
   * it. Excluded from the "prior paid sale" count — see rule 4 below.
   */
  intendedOrderId?: string
}

function reject(reason: ValidationReason): ValidationResult {
  return { valid: false, reason, message: VALIDATION_REASON_MESSAGE_ES[reason] }
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
 *   4. The presenter must have no PRIOR PAID sale in this venue.
 *
 * 🔴 Rule 4 used to be "zero prior Orders in this venue, in any state", and
 * that was a defect in two directions at once (founder decision 2026-08-18,
 * after comparing Mindbody / Booksy / Square):
 *
 *   a) It disqualified people who never bought anything. A booking, an
 *      abandoned cart or a cancelled check leaves an `Order` row, so a
 *      customer who "exists" but never paid was refused forever. The market
 *      defines new by MONEY: Booksy charges only for "visits that actually
 *      took place", Square requires "one payment greater than $1", Mindbody
 *      claims the offer only when the brand-new client makes a purchase.
 *      Capture is attribution, not the reward — the reward still waits for
 *      the first completed payment (`onOrderPaid`).
 *
 *   b) It made the POS flow impossible. Android and iOS capture on payment
 *      SUCCESS, so by the time they call, the sale of THIS checkout already
 *      exists and is PAID for this customer — counting it rejected every
 *      single mobile capture with EXISTING_CUSTOMER. Passing
 *      `intendedOrderId` excludes exactly that one order, and nothing else.
 *
 * Both money signals are checked (`paymentStatus: PAID` OR a COMPLETED
 * REGULAR payment) because prod carries historically inconsistent rows —
 * orders left PENDING with completed payments attached. `cancelOrder` in
 * `order.dashboard.service.ts` already guards with the same pair.
 */
export async function validateReferralCode(input: ValidateInput): Promise<ValidationResult> {
  const config = await prisma.referralProgramConfig.findUnique({
    where: { venueId: input.venueId },
    select: { active: true, newCustomerDiscountPercent: true },
  })
  if (!config || !config.active) {
    return reject('PROGRAM_INACTIVE')
  }

  const referrer = await prisma.customer.findFirst({
    where: { venueId: input.venueId, referralCode: input.referralCode },
    select: { id: true, firstName: true, lastName: true },
  })
  if (!referrer) {
    return reject('CODE_NOT_FOUND')
  }

  if (referrer.id === input.newCustomerId) {
    return reject('SELF_REFERRAL')
  }

  const priorPaidOrderCount = await prisma.order.count({
    where: {
      customerId: input.newCustomerId,
      venueId: input.venueId,
      ...(input.intendedOrderId ? { id: { not: input.intendedOrderId } } : {}),
      OR: [{ paymentStatus: 'PAID' }, { payments: { some: { status: 'COMPLETED', type: 'REGULAR' } } }],
    },
  })
  if (priorPaidOrderCount > 0) {
    return reject('EXISTING_CUSTOMER')
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
 * Keep `intendedOrderId` only when it really is an order of this venue.
 *
 * WHY: the POS can hand us an id the server has never seen — a provisional
 * id from an offline/table session, or a stale one. `Referral
 * .qualifyingOrderId` is an FK, so persisting it would throw and turn the
 * capture into a 500: the cashier sees a red error right after a successful
 * charge, and the attribution is lost anyway. Capture must never block the
 * sale, so we do exactly what `resolveStaffVenueId` does — drop the link,
 * keep the row. Tenant-scoped on purpose: another venue's order is as
 * unusable here as a made-up one.
 */
async function resolveIntendedOrderId(venueId: string, candidate: string | null | undefined): Promise<string | null> {
  if (!candidate) return null
  const order = await prisma.order.findFirst({ where: { id: candidate, venueId }, select: { id: true } })
  return order?.id ?? null
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
  const qualifyingOrderId = await resolveIntendedOrderId(input.venueId, input.intendedOrderId)

  const validation = await validateReferralCode({
    venueId: input.venueId,
    referralCode: input.referralCode,
    newCustomerId: input.newCustomerId,
    // Must travel: re-running validation without it counts the very sale we
    // are about to attach the referral to as a "prior paid order", so every
    // capture-on-payment-success would reject itself with EXISTING_CUSTOMER.
    intendedOrderId: qualifyingOrderId ?? undefined,
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
      qualifyingOrderId,
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
