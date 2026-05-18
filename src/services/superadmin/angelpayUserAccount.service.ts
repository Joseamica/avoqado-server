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
 * pinEncrypted is nullable: null when status=PENDING_PIN (no PIN yet);
 *   { encrypted, iv } shape (AES-256-CBC) once setPin() lands. Encryption
 *   reuses the merchantAccount.service.ts helper for a single canonical
 *   credentials-at-rest format across all provider account types.
 *
 * Convention note: this file follows the standalone-exported-function
 * pattern used by every other service in src/services/superadmin/
 * (see merchantAccount.service.ts) rather than a class wrapper.
 *
 * Spec: §3.2, §4.1, §18.2
 */

import prisma from '../../utils/prismaClient'
import { AngelPayAccountStatus, type AngelPayUserAccount } from '@prisma/client'
import { ValidationError, ConflictError } from '../../errors/AppError'
import { encryptCredentials } from './merchantAccount.service'

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
 * - If pin provided: status=ACTIVE, pinEncrypted={ encrypted, iv }.
 * - If pin omitted: status=PENDING_PIN, pinEncrypted=null.
 *
 * Special case — reactivation of DELETED row:
 * - If the existing row has status=DELETED, this call UPDATES it in place
 *   (new email, new pin if provided, new env, status flipped back to ACTIVE
 *   or PENDING_PIN based on whether pin was provided). This matches the
 *   dashboard UX which warns "Cuenta existente en estado DELETED. Conectar
 *   reemplazará el PIN actual." — the row is reused (preserves audit trail
 *   on `createdAt`, `externalUserId` if previously discovered) instead of
 *   a hard delete + insert cycle that would orphan downstream references.
 *
 * - If the existing row has any other non-DELETED status, throws
 *   ConflictError — admin must explicitly soft-delete first via the
 *   delete flow before reconnecting.
 */
export async function createAngelPayUserAccount(input: CreateAngelPayUserAccountInput): Promise<AngelPayUserAccount> {
  if (!EMAIL_REGEX.test(input.email)) {
    throw new ValidationError('Invalid email format')
  }
  if (input.pin !== undefined && !PIN_REGEX.test(input.pin)) {
    throw new ValidationError('PIN must be 6 numeric digits')
  }

  const existing = await prisma.angelPayUserAccount.findUnique({
    where: { venueId: input.venueId },
  })

  const pinEncrypted = input.pin ? encryptCredentials(input.pin) : null
  const status: AngelPayAccountStatus = input.pin ? AngelPayAccountStatus.ACTIVE : AngelPayAccountStatus.PENDING_PIN

  if (existing) {
    if (existing.status === AngelPayAccountStatus.DELETED) {
      // Reactivate: same row, new credentials. Clears prior validation error/reason
      // so the audit trail (statusChangedAt) reflects this reactivation event.
      return prisma.angelPayUserAccount.update({
        where: { id: existing.id },
        data: {
          email: input.email,
          environment: input.environment,
          pinEncrypted: pinEncrypted as any,
          status,
          statusChangedAt: new Date(),
          statusChangedBy: input.createdBy ?? null,
          statusReason: null,
          lastValidationErr: null,
        },
      })
    }
    throw new ConflictError('Venue already has an AngelPay user account')
  }

  return prisma.angelPayUserAccount.create({
    data: {
      venueId: input.venueId,
      email: input.email,
      environment: input.environment,
      pinEncrypted: pinEncrypted as any,
      status,
      statusChangedAt: new Date(),
      statusChangedBy: input.createdBy ?? null,
      createdBy: input.createdBy ?? null,
    },
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
      pinEncrypted: encryptCredentials(newPin) as any,
      status: AngelPayAccountStatus.ACTIVE,
      statusChangedAt: new Date(),
      statusReason: null,
      lastValidationErr: null,
    },
  })
}

export async function markAngelPayUserAccountRotationRequired(
  id: string,
  reason: string,
  changedBy: string,
): Promise<AngelPayUserAccount> {
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

export async function suspendAngelPayUserAccount(
  id: string,
  reason: string,
  changedBy: string,
): Promise<AngelPayUserAccount> {
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
 * Lookup by venueId — used by the superadmin dashboard GET endpoint.
 * Returns null if the venue has no AngelPay account (e.g., never configured).
 */
export async function getAngelPayUserAccountByVenueId(venueId: string): Promise<AngelPayUserAccount | null> {
  return prisma.angelPayUserAccount.findUnique({
    where: { venueId },
  })
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
 * Lookup helper: TPV → terminal → venue → angelpayUserAccount.
 * Returns null if terminal missing or venue has no AngelPay account.
 */
export async function getAngelPayUserAccountForTerminal(serialNumber: string): Promise<AngelPayUserAccount | null> {
  const terminal = await prisma.terminal.findUnique({
    where: { serialNumber },
    include: { venue: { include: { angelpayUserAccount: true } } },
  })
  return terminal?.venue?.angelpayUserAccount ?? null
}
