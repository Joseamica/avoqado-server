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
import logger from '../../config/logger'
import { angelPayIdentityConflict, lockAngelPayVenue } from '../../lib/angelpayIdentity'
import { decryptCredentials } from './merchantAccount.service'

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
 *   UPDATES it in place (new pin if provided, SAME environment, status flipped back to
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
    throw new ValidationError('Formato de correo inválido')
  }
  if (input.pin !== undefined && !PIN_REGEX.test(input.pin)) {
    throw new ValidationError('PIN must be 6 numeric digits')
  }

  return prisma.$transaction(async tx => {
    await lockAngelPayVenue(tx, input.venueId)
    // Match on (venueId, email) instead of venueId alone. Multi-account venues
    // can have several rows; we only want to reactivate the SAME email's row.
    const existing = await tx.angelPayUserAccount.findUnique({
      where: { venueId_email: { venueId: input.venueId, email: input.email } },
    })

    const pin = input.pin ?? null
    const status: AngelPayAccountStatus = input.pin ? AngelPayAccountStatus.ACTIVE : AngelPayAccountStatus.PENDING_PIN

    if (existing) {
      if (existing.status === AngelPayAccountStatus.DELETED) {
        if (existing.environment !== input.environment) throw angelPayIdentityConflict()
        // Reactivate: same identity, refreshed PIN. Clears prior validation error/reason
        // so the audit trail (statusChangedAt) reflects this reactivation event.
        return tx.angelPayUserAccount.update({
          where: { id: existing.id },
          data: {
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
      return await tx.angelPayUserAccount.create({
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
  })
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

/** Correct an unused PENDING_PIN draft; linked or SDK-accredited identity is permanent. */
export async function updateAngelPayUserAccountCredentials(
  id: string,
  updates: { email?: string; environment?: 'QA' | 'PROD' },
): Promise<AngelPayUserAccount> {
  const account = await prisma.angelPayUserAccount.findUnique({ where: { id } })
  if (!account) throw new NotFoundError('Cuenta AngelPay no encontrada')
  return prisma.$transaction(async tx => {
    await lockAngelPayVenue(tx, account.venueId)
    const existing = await tx.angelPayUserAccount.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Cuenta AngelPay no encontrada')
    const data: { email?: string; environment?: 'QA' | 'PROD' } = {}
    if (updates.email !== undefined && updates.email !== existing.email) {
      const email = updates.email.trim()
      if (!EMAIL_REGEX.test(email)) throw new ValidationError('El correo no es válido')
      if (email !== existing.email) data.email = email
    }
    if (updates.environment !== undefined && updates.environment !== existing.environment) {
      if (updates.environment !== 'QA' && updates.environment !== 'PROD') {
        throw new ValidationError('El ambiente debe ser QA o PROD')
      }
      data.environment = updates.environment
    }
    if (Object.keys(data).length === 0) return existing
    const linked = await tx.merchantAccount.count({ where: { angelpayUserAccountId: id } })
    if (existing.status !== AngelPayAccountStatus.PENDING_PIN || existing.externalUserId !== null || linked > 0) {
      throw angelPayIdentityConflict()
    }
    try {
      const written = await tx.angelPayUserAccount.updateMany({
        where: { id, status: AngelPayAccountStatus.PENDING_PIN, externalUserId: null, merchantAccounts: { none: {} } },
        data,
      })
      if (written.count !== 1) throw angelPayIdentityConflict()
      return { ...existing, ...data }
    } catch (err: any) {
      if (err?.code === 'P2002') throw new ConflictError('Ya existe una cuenta AngelPay con ese correo en este venue')
      throw err
    }
  })
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
  if (!existing) throw new NotFoundError(`Cuenta AngelPay ${id} no encontrada`)
  if (existing.status !== AngelPayAccountStatus.DELETED) {
    throw new ConflictError(`Sólo se reactivan las cuentas eliminadas. Estado actual: ${existing.status}`)
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

/** Hard-delete only orphan logins. The legacy cascade option never detaches historical accounts. */
export async function hardDeleteAngelPayUserAccount(
  id: string,
  changedBy: string,
  opts: { cascadeMerchants: boolean } = { cascadeMerchants: false },
): Promise<{ deletedAccountId: string; detachedMerchantIds: string[] }> {
  const account = await prisma.angelPayUserAccount.findUnique({ where: { id } })
  if (!account) throw new NotFoundError('Cuenta AngelPay no encontrada')
  const result = await prisma.$transaction(async tx => {
    await lockAngelPayVenue(tx, account.venueId)
    const existing = await tx.angelPayUserAccount.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('Cuenta AngelPay no encontrada')
    if (await tx.merchantAccount.count({ where: { angelpayUserAccountId: id } })) throw angelPayIdentityConflict()
    await tx.angelPayUserAccount.delete({ where: { id } })
    return { deletedAccountId: id, detachedMerchantIds: [] as string[] }
  })
  logger.info('AngelPay user account hard-deleted', {
    event: 'angelpay.account.hard_deleted',
    accountId: id,
    changedBy,
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
  const account = await prisma.angelPayUserAccount.findUnique({ where: { id } })
  if (!account) throw new NotFoundError('Cuenta AngelPay no encontrada')
  return prisma.$transaction(async tx => {
    await lockAngelPayVenue(tx, account.venueId)
    const written = await tx.angelPayUserAccount.updateMany({
      where: { id, OR: [{ externalUserId: null }, { externalUserId }] },
      data: { lastValidatedAt: new Date(), externalUserId, lastValidationErr: null },
    })
    if (written.count !== 1) throw angelPayIdentityConflict()
    return tx.angelPayUserAccount.findUniqueOrThrow({ where: { id } })
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
/**
 * Lee el PIN de una cuenta AngelPay. **Es la ÚNICA vía por la que el PIN sale
 * del backend**: todas las respuestas normales lo borran (`sanitize()` en el
 * controller), a propósito, para que no viaje en listados ni en el detalle de
 * un merchant. Aquí se pide explícitamente, y el controller lo registra.
 *
 * `pin` en claro es la fuente de verdad; se cae al `pinEncrypted` legacy para
 * las filas anteriores al cambio a texto plano — mismo patrón que el TPV en
 * `terminal.tpv.controller.ts`. `null` = la cuenta todavía no tiene PIN
 * (status PENDING_PIN), que NO es un error.
 */
export async function getAngelPayUserAccountPin(id: string): Promise<string | null> {
  const account = await prisma.angelPayUserAccount.findUnique({
    where: { id },
    select: { pin: true, pinEncrypted: true },
  })
  if (!account) {
    throw new NotFoundError('Cuenta AngelPay no encontrada')
  }
  if (account.pin) return account.pin
  if (!account.pinEncrypted) return null
  try {
    return decryptCredentials(account.pinEncrypted) as string
  } catch (error) {
    // Un PIN legacy ilegible no puede pasar por "esta cuenta no tiene PIN":
    // eso mandaría al operador a teclear uno nuevo y a romper la sesión viva.
    logger.error('Failed to decrypt legacy AngelPay PIN', { accountId: id, error })
    throw new BadRequestError('El PIN guardado de esta cuenta no se pudo leer (formato antiguo ilegible)')
  }
}

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
