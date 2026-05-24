/**
 * AngelPayUserAccount lifecycle service (D3).
 *
 * Per-venue AngelPay user credentials for SDK 1.0.5+. Separate from
 * MerchantAccount: AngelPay binds a single user to a venue, while
 * MerchantAccount represents per-tender provider routing.
 *
 * Status lifecycle:
 *   PENDING_PIN → ACTIVE ↔ PIN_ROTATION_REQUIRED → SUSPENDED → DELETED
 *
 * pin is nullable plaintext: null when status=PENDING_PIN (no PIN yet);
 *   the 6-digit PIN once setPin() lands. Stored plaintext by decision
 *   (spec 2026-05-21-angelpay-merchant-wizard §6.1) — unrelated to
 *   StaffVenue.pin.
 *
 * Convention note: this file follows the standalone-exported-function
 * pattern used by every other service in src/services/superadmin/
 * (see merchantAccount.service.ts) rather than a class wrapper.
 *
 * Spec: §3.2, §4.1, §18.2
 */

import prisma from '../../utils/prismaClient'
import { AngelPayAccountStatus, type AngelPayUserAccount } from '@prisma/client'
import { BadRequestError, ConflictError, NotFoundError, ValidationError } from '../../errors/AppError'
import { tpvCommandQueueService } from '../tpv/command-queue.service'
import logger from '../../config/logger'

const PIN_REGEX = /^\d{6}$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface CreateAngelPayUserAccountInput {
  venueId: string
  email: string
  pin?: string
  environment: 'QA' | 'PROD'
  createdBy?: string
}

/**
 * Create a per-venue AngelPay user account.
 * - email validated against RFC-ish regex.
 * - pin (optional) must be 6 numeric digits.
 * - If pin provided: status=ACTIVE, pin stored plaintext.
 * - If pin omitted: status=PENDING_PIN, pin=null.
 *
 * Multi-account per venue (2026-05-18): a venue can register multiple AngelPay
 * logins (one per AngelPay merchant when the venue runs several merchants
 * under different emails). Uniqueness is enforced on `(venueId, email)` —
 * Prisma surfaces dup-on-create as P2002, which we translate to ConflictError.
 *
 * Special case — reactivation of DELETED row:
 * - If a row exists for `(venueId, email)` with status=DELETED, this call
 *   UPDATES it in place (new pin if provided, new env, status flipped back to
 *   ACTIVE or PENDING_PIN). The row is reused (preserves audit trail on
 *   `createdAt`, `externalUserId` if previously discovered) instead of a hard
 *   delete + insert cycle that would orphan downstream references.
 *
 * - If a row exists for `(venueId, email)` with any other non-DELETED status,
 *   throws ConflictError — admin must explicitly soft-delete first via the
 *   delete flow before reconnecting (matches pre-multi-account semantics for
 *   this email).
 */
export async function createAngelPayUserAccount(input: CreateAngelPayUserAccountInput): Promise<AngelPayUserAccount> {
  if (!EMAIL_REGEX.test(input.email)) {
    throw new ValidationError('Invalid email format')
  }
  if (input.pin !== undefined && !PIN_REGEX.test(input.pin)) {
    throw new ValidationError('PIN must be 6 numeric digits')
  }

  // Match on (venueId, email) instead of venueId alone. Multi-account venues
  // can have several rows; we only want to reactivate the SAME email's row.
  const existing = await prisma.angelPayUserAccount.findUnique({
    where: { venueId_email: { venueId: input.venueId, email: input.email } },
  })

  const pin = input.pin ?? null
  const status: AngelPayAccountStatus = input.pin ? AngelPayAccountStatus.ACTIVE : AngelPayAccountStatus.PENDING_PIN

  if (existing) {
    if (existing.status === AngelPayAccountStatus.DELETED) {
      // Reactivate: same row, new credentials. Clears prior validation error/reason
      // so the audit trail (statusChangedAt) reflects this reactivation event.
      return prisma.angelPayUserAccount.update({
        where: { id: existing.id },
        data: {
          environment: input.environment,
          pin,
          status,
          statusChangedAt: new Date(),
          statusChangedBy: input.createdBy ?? null,
          statusReason: null,
          lastValidationErr: null,
        },
      })
    }
    throw new ConflictError('Ya existe una cuenta AngelPay con ese correo en este venue')
  }

  try {
    return await prisma.angelPayUserAccount.create({
      data: {
        venueId: input.venueId,
        email: input.email,
        environment: input.environment,
        pin,
        status,
        statusChangedAt: new Date(),
        statusChangedBy: input.createdBy ?? null,
        createdBy: input.createdBy ?? null,
      },
    })
  } catch (err: any) {
    // Race-condition safety net: if another transaction inserted the same
    // (venueId, email) pair between our findUnique and create, Prisma P2002
    // fires. Translate to ConflictError so the controller maps to HTTP 409.
    if (err?.code === 'P2002') {
      throw new ConflictError('Ya existe una cuenta AngelPay con ese correo en este venue')
    }
    throw err
  }
}

/**
 * Set/rotate the PIN. Always transitions to ACTIVE and clears any
 * lingering validation error / status reason from earlier states
 * (PENDING_PIN → ACTIVE, PIN_ROTATION_REQUIRED → ACTIVE).
 */
export async function setAngelPayUserAccountPin(id: string, newPin: string): Promise<AngelPayUserAccount> {
  if (!PIN_REGEX.test(newPin)) {
    throw new ValidationError('PIN must be 6 numeric digits')
  }
  return prisma.angelPayUserAccount.update({
    where: { id },
    data: {
      pin: newPin,
      status: AngelPayAccountStatus.ACTIVE,
      statusChangedAt: new Date(),
      statusReason: null,
      lastValidationErr: null,
    },
  })
}

/**
 * Update credentials (email + environment) of an UNCONFIRMED account.
 *
 * Only allowed while the account is still in `PENDING_PIN` — meaning ops
 * created it (typically with the wrong email or env) but no one has yet
 * set a PIN. After ACTIVE/PIN_ROTATION_REQUIRED/SUSPENDED, the email is
 * locked because (a) the SDK has likely validated against it (externalUserId
 * populated) and (b) the TPV may have cached creds against that login.
 *
 * Same uniqueness constraint as create — `(venueId, email)` must stay unique
 * for the venue. Prisma's P2002 surfaces as ConflictError.
 */
export async function updateAngelPayUserAccountCredentials(
  id: string,
  updates: { email?: string; environment?: 'QA' | 'PROD' },
): Promise<AngelPayUserAccount> {
  const existing = await prisma.angelPayUserAccount.findUnique({ where: { id } })
  if (!existing) {
    throw new NotFoundError('AngelPay account not found')
  }
  if (existing.status !== AngelPayAccountStatus.PENDING_PIN) {
    throw new ValidationError(`Solo se pueden editar credenciales en cuentas PENDING_PIN. Estado actual: ${existing.status}.`)
  }
  const data: Record<string, unknown> = {}
  if (updates.email !== undefined) {
    const trimmed = updates.email.trim()
    if (!trimmed) throw new ValidationError('email no puede estar vacío')
    data.email = trimmed
  }
  if (updates.environment !== undefined) {
    if (updates.environment !== 'QA' && updates.environment !== 'PROD') {
      throw new ValidationError('environment debe ser QA o PROD')
    }
    data.environment = updates.environment
  }
  if (Object.keys(data).length === 0) {
    return existing // nothing to update — return current row
  }

  try {
    return await prisma.angelPayUserAccount.update({ where: { id }, data })
  } catch (err: any) {
    // Prisma P2002 = compound unique violation on (venueId, email)
    if (err?.code === 'P2002') {
      throw new ConflictError('Ya existe una cuenta AngelPay con ese correo en este venue')
    }
    throw err
  }
}

export async function markAngelPayUserAccountRotationRequired(id: string, reason: string, changedBy: string): Promise<AngelPayUserAccount> {
  return prisma.angelPayUserAccount.update({
    where: { id },
    data: {
      status: AngelPayAccountStatus.PIN_ROTATION_REQUIRED,
      statusChangedAt: new Date(),
      statusChangedBy: changedBy,
      statusReason: reason,
    },
  })
}

export async function suspendAngelPayUserAccount(id: string, reason: string, changedBy: string): Promise<AngelPayUserAccount> {
  return prisma.angelPayUserAccount.update({
    where: { id },
    data: {
      status: AngelPayAccountStatus.SUSPENDED,
      statusChangedAt: new Date(),
      statusChangedBy: changedBy,
      statusReason: reason,
    },
  })
}

export async function softDeleteAngelPayUserAccount(id: string, changedBy: string): Promise<AngelPayUserAccount> {
  return prisma.angelPayUserAccount.update({
    where: { id },
    data: {
      status: AngelPayAccountStatus.DELETED,
      statusChangedAt: new Date(),
      statusChangedBy: changedBy,
    },
  })
}

/**
 * Reactivate a DELETED AngelPay account → ACTIVE (or PENDING_PIN if it has no
 * PIN yet). Useful when an operator soft-deleted a row by mistake or wants to
 * un-archive a previously decommissioned login without going through the
 * create flow.
 *
 * - Throws ConflictError if the account isn't in DELETED state.
 * - Does NOT touch credentials — PIN, email, environment stay as they were.
 * - statusChangedAt + statusChangedBy reflect this reactivation event.
 */
export async function reactivateAngelPayUserAccount(id: string, changedBy: string): Promise<AngelPayUserAccount> {
  const existing = await prisma.angelPayUserAccount.findUnique({ where: { id } })
  if (!existing) throw new NotFoundError(`AngelPay account ${id} not found`)
  if (existing.status !== AngelPayAccountStatus.DELETED) {
    throw new ConflictError(`Only DELETED accounts can be reactivated. Current status: ${existing.status}`)
  }
  const nextStatus = existing.pin ? AngelPayAccountStatus.ACTIVE : AngelPayAccountStatus.PENDING_PIN
  return prisma.angelPayUserAccount.update({
    where: { id },
    data: {
      status: nextStatus,
      statusChangedAt: new Date(),
      statusChangedBy: changedBy,
      statusReason: null,
      lastValidationErr: null,
    },
  })
}

/**
 * Hard-delete an AngelPay account — physically remove the row from the DB.
 *
 * Unlike `softDeleteAngelPayUserAccount`, this does NOT preserve the audit
 * trail. Use only for cleanup (test data, GDPR, decommission). Operators
 * normally want soft delete.
 *
 * Behavior re: merchant relations:
 *  - The `MerchantAccount.angelpayUserAccountId` FK has `onDelete: SetNull`
 *    in Prisma, so any merchants still bound to this account become orphan
 *    (`angelpayUserAccountId = null`).
 *  - To prevent silent orphaning, this function checks the count first:
 *    - if `cascadeMerchants=false` (default) and there are bound merchants,
 *      throws ConflictError with the count → caller must detach first OR
 *      retry with `cascadeMerchants=true`.
 *    - if `cascadeMerchants=true`, the explicit SetNull is applied in the
 *      same transaction (defensive against FK behavior changes) and then
 *      the row is deleted.
 */
export async function hardDeleteAngelPayUserAccount(
  id: string,
  changedBy: string,
  opts: { cascadeMerchants: boolean } = { cascadeMerchants: false },
): Promise<{ deletedAccountId: string; detachedMerchantIds: string[] }> {
  const existing = await prisma.angelPayUserAccount.findUnique({
    where: { id },
    include: { merchantAccounts: { select: { id: true } } },
  })
  if (!existing) throw new NotFoundError(`AngelPay account ${id} not found`)
  const merchantIds = existing.merchantAccounts.map(m => m.id)

  if (merchantIds.length > 0 && !opts.cascadeMerchants) {
    throw new ConflictError(
      `Account has ${merchantIds.length} merchant(s) still bound. Detach them first or pass cascadeMerchants=true.`,
    )
  }

  const result = await prisma.$transaction(async tx => {
    if (merchantIds.length > 0) {
      await tx.merchantAccount.updateMany({
        where: { angelpayUserAccountId: id },
        data: { angelpayUserAccountId: null },
      })
    }
    await tx.angelPayUserAccount.delete({ where: { id } })
    return { deletedAccountId: id, detachedMerchantIds: merchantIds }
  })

  logger.info('AngelPay user account hard-deleted', {
    event: 'angelpay.account.hard_deleted',
    accountId: id,
    changedBy,
    detachedMerchants: merchantIds.length,
    cascadeMerchants: opts.cascadeMerchants,
  })

  return result
}

/**
 * Called by TPV after a successful AngelPay SDK validation handshake.
 * Records the SDK-returned externalUserId for future lookups and clears
 * any prior validation error. Does NOT change status.
 */
export async function markAngelPayUserAccountValidated(id: string, externalUserId: number): Promise<AngelPayUserAccount> {
  return prisma.angelPayUserAccount.update({
    where: { id },
    data: {
      lastValidatedAt: new Date(),
      externalUserId,
      lastValidationErr: null,
    },
  })
}

/**
 * Called by TPV when the SDK rejects credentials. Records the error
 * verbatim for ops triage. Does NOT change status — status transitions
 * (e.g., to PIN_ROTATION_REQUIRED) are explicit ops actions.
 */
export async function recordAngelPayUserAccountError(id: string, message: string): Promise<AngelPayUserAccount> {
  return prisma.angelPayUserAccount.update({
    where: { id },
    data: { lastValidationErr: message },
  })
}

/**
 * @deprecated Multi-account per venue (2026-05-18): use
 * {@link getAngelPayUserAccountsByVenueId} (plural) which returns the full
 * list. This singular variant is preserved for backward compatibility with
 * pre-multi-account callers — it returns the OLDEST active row (or any row
 * if none are active) so legacy code that assumed "one account per venue"
 * continues to find *something*. New code should switch to the plural form.
 *
 * Returns null if the venue has no AngelPay account (e.g., never configured).
 */
export async function getAngelPayUserAccountByVenueId(venueId: string): Promise<AngelPayUserAccount | null> {
  // Pick a stable, predictable row: oldest first so re-runs return the same
  // account. Filter out DELETED so legacy callers don't get a soft-deleted
  // row back (they would have failed before anyway because the unique row
  // was DELETED).
  return prisma.angelPayUserAccount.findFirst({
    where: { venueId, status: { not: AngelPayAccountStatus.DELETED } },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * Multi-account-aware lookup. Returns every AngelPay account registered for
 * the venue (excluding soft-deleted rows), oldest-first so the dashboard
 * lists them in a stable order. Always returns an array — empty when the
 * venue has not been provisioned yet.
 */
export async function getAngelPayUserAccountsByVenueId(venueId: string): Promise<AngelPayUserAccount[]> {
  return prisma.angelPayUserAccount.findMany({
    where: { venueId, status: { not: AngelPayAccountStatus.DELETED } },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * Lookup the AngelPay account linked to a specific MerchantAccount via the
 * `angelpayUserAccountId` FK. Returns null when the merchant is not linked
 * (legacy/un-backfilled row, or a non-AngelPay provider).
 *
 * Used by the TPV switch flow so the cashier-side merchant picker can route
 * back to "which AngelPay login owns this merchant?" without re-querying
 * AngelPay's SDK.
 */
export async function getAngelPayUserAccountForMerchantAccount(merchantAccountId: string): Promise<AngelPayUserAccount | null> {
  const ma = await prisma.merchantAccount.findUnique({
    where: { id: merchantAccountId },
    include: { angelpayUserAccount: true },
  })
  return ma?.angelpayUserAccount ?? null
}

/**
 * Lookup by id — used by mutation endpoints that need to verify the account
 * exists before issuing the update (so we can return 404 instead of a generic
 * Prisma error).
 */
export async function getAngelPayUserAccountById(id: string): Promise<AngelPayUserAccount | null> {
  return prisma.angelPayUserAccount.findUnique({
    where: { id },
  })
}

/**
 * Lookup helper: TPV → terminal → venue → angelpayUserAccount (first non-DELETED).
 *
 * Multi-account note (2026-05-18): venues can now have multiple AngelPay
 * accounts. This helper preserves the legacy "pick one" behaviour by returning
 * the oldest non-DELETED row so the terminal config payload's `angelpayAuth`
 * field (single-account contract) stays populated. The new `angelpayAccounts`
 * list field in the terminal config response surfaces ALL accounts for callers
 * that need the full list.
 *
 * Returns null if terminal missing or venue has no AngelPay account.
 */
export async function getAngelPayUserAccountForTerminal(serialNumber: string): Promise<AngelPayUserAccount | null> {
  const terminal = await prisma.terminal.findUnique({
    where: { serialNumber },
    include: {
      venue: {
        include: {
          angelpayUserAccounts: {
            where: { status: { not: AngelPayAccountStatus.DELETED } },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
      },
    },
  })
  return terminal?.venue?.angelpayUserAccounts?.[0] ?? null
}

/**
 * Multi-account-aware variant of {@link getAngelPayUserAccountForTerminal}.
 * Returns every non-DELETED AngelPay account registered for the terminal's
 * venue. Used by the terminal config endpoint to populate the new
 * `angelpayAccounts` list field on the response so the TPV can switch
 * between accounts at runtime.
 */
export async function getAngelPayUserAccountsForTerminal(serialNumber: string): Promise<AngelPayUserAccount[]> {
  const terminal = await prisma.terminal.findUnique({
    where: { serialNumber },
    include: {
      venue: {
        include: {
          angelpayUserAccounts: {
            where: { status: { not: AngelPayAccountStatus.DELETED } },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  })
  return terminal?.venue?.angelpayUserAccounts ?? []
}
