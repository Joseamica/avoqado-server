import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError, ValidationError } from '../../errors/AppError'
import crypto from 'crypto'
import socketManager from '../../communication/sockets'
import { lookupRatesByBusinessName, lookupRatesByVenueType, type MCCLookupResult } from '../pricing/blumon-mcc-lookup.service'
import { assertMerchantTerminalCompatible, assertVenueHasCompatibleTerminal } from '../../lib/providerDeviceCompatibility'

/**
 * MerchantAccount Service
 *
 * Manages merchant accounts for payment providers.
 * Each merchant account represents a specific set of credentials
 * for processing payments with a provider (Menta, Clip, etc.)
 *
 * SECURITY:
 * - Credentials are encrypted before storage
 * - Decryption only happens when needed (e.g., for payment processing)
 */

// Encryption utilities
const ENCRYPTION_KEY_RAW = process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY || 'default-key-change-in-production-use-env-var'
// Derive a 32-byte key using SHA-256 (always produces 32 bytes)
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY_RAW).digest()
const ALGORITHM = 'aes-256-cbc'

/**
 * Encrypt credentials object
 * @param credentials Plain credentials object
 * @returns Encrypted credentials object with iv
 */
export function encryptCredentials(credentials: any): any {
  try {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv)

    let encrypted = cipher.update(JSON.stringify(credentials), 'utf8', 'hex')
    encrypted += cipher.final('hex')

    return {
      encrypted,
      iv: iv.toString('hex'),
    }
  } catch (error) {
    logger.error('Failed to encrypt credentials', { error })
    throw new Error('Credential encryption failed')
  }
}

/**
 * Decrypt credentials object
 * @param encryptedData Encrypted credentials with iv
 * @returns Plain credentials object
 */
export function decryptCredentials(encryptedData: any): any {
  try {
    if (!encryptedData || !encryptedData.encrypted || !encryptedData.iv) {
      throw new Error('Invalid encrypted data format')
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, Buffer.from(encryptedData.iv, 'hex'))

    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return JSON.parse(decrypted)
  } catch (error) {
    logger.error('Failed to decrypt credentials', { error })
    throw new Error('Credential decryption failed')
  }
}

/**
 * Notify terminals when merchant configuration changes
 * Part of the 3-layer cache invalidation strategy (Layer 1: PUSH)
 *
 * Pattern inspired by Toast/Square: Backend is SOURCE OF TRUTH, push notifications for critical changes.
 *
 * @param merchantId The ID of the merchant that changed
 * @param merchantName The display name of the merchant
 * @param changeType The type of change that occurred
 * @param urgent Whether the terminal should refresh immediately (true for DELETED, false otherwise)
 */
export async function notifyAffectedTerminals(
  merchantId: string,
  merchantName: string,
  changeType: 'MERCHANT_ADDED' | 'MERCHANT_UPDATED' | 'MERCHANT_DELETED',
  urgent: boolean = false,
): Promise<void> {
  try {
    // Find all terminals that have this merchant assigned
    const affectedTerminals = await prisma.terminal.findMany({
      where: {
        assignedMerchantIds: {
          has: merchantId,
        },
      },
      select: {
        id: true,
        serialNumber: true,
        name: true,
        venueId: true,
      },
    })

    if (affectedTerminals.length === 0) {
      logger.debug('No terminals affected by merchant change', {
        merchantId,
        changeType,
      })
      return
    }

    const broadcastingService = socketManager.getBroadcastingService()
    if (!broadcastingService) {
      logger.warn('Broadcasting service not available, cannot notify terminals of merchant change', {
        merchantId,
        changeType,
        affectedTerminalCount: affectedTerminals.length,
      })
      return
    }

    // Generate a config version (timestamp-based)
    const configVersion = Date.now()

    // Group terminals by venue and broadcast once per venue
    const venueTerminals = affectedTerminals.reduce(
      (acc, terminal) => {
        if (!acc[terminal.venueId]) {
          acc[terminal.venueId] = []
        }
        acc[terminal.venueId].push(terminal)
        return acc
      },
      {} as Record<string, typeof affectedTerminals>,
    )

    // Broadcast to each affected venue
    for (const [venueId, terminals] of Object.entries(venueTerminals)) {
      for (const terminal of terminals) {
        broadcastingService.broadcastTerminalConfigChanged(venueId, {
          terminalId: terminal.id,
          terminalSerialNumber: terminal.serialNumber || terminal.id,
          changeType,
          merchantId,
          merchantName,
          configVersion,
          urgent,
          reason: `Merchant "${merchantName}" was ${changeType.toLowerCase().replace('merchant_', '')}`,
        })
      }
    }

    logger.info('🔔 Terminal config change notifications sent', {
      merchantId,
      merchantName,
      changeType,
      urgent,
      affectedTerminalCount: affectedTerminals.length,
      affectedVenueCount: Object.keys(venueTerminals).length,
      configVersion,
    })
  } catch (error) {
    // Don't throw - this is a best-effort notification
    // The 3-layer architecture ensures terminals will eventually sync via heartbeat or backend validation
    logger.error('Failed to notify terminals of merchant change (non-blocking)', {
      merchantId,
      changeType,
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

interface CreateMerchantAccountData {
  providerId: string
  externalMerchantId: string
  alias?: string
  displayName?: string
  active?: boolean
  displayOrder?: number
  // 🆕 Optional venue scope (Task 10) — when supplied, gates creation on
  // provider↔device compatibility (`assertVenueHasCompatibleTerminal`) and
  // unlocks the AngelPay-specific branch which requires an ACTIVE
  // `AngelPayUserAccount` for that venue. Existing callers (Blumon flows)
  // that omit this field keep the legacy behavior.
  venueId?: string
  // Credentials are optional for Blumon pending accounts (will be fetched via OAuth later)
  credentials?: {
    merchantId?: string // Optional - not all providers use this
    apiKey?: string // Optional - not all providers use this
    customerId?: string
    [key: string]: any // Allow provider-specific fields (OAuth tokens, DUKPT keys, etc.)
  }
  providerConfig?: any
  // Blumon-specific fields (optional for other providers)
  blumonSerialNumber?: string
  blumonPosId?: string
  blumonEnvironment?: string
  blumonMerchantId?: string
  // Bank account fields (optional)
  clabeNumber?: string | null
  bankName?: string | null
  accountHolder?: string | null
}

interface UpdateMerchantAccountData {
  externalMerchantId?: string
  alias?: string
  displayName?: string
  active?: boolean
  displayOrder?: number
  credentials?: {
    merchantId?: string
    apiKey?: string
    customerId?: string
    [key: string]: any
  }
  providerConfig?: any
}

/**
 * Get all merchant accounts with optional filters
 * @param filters Optional filters for provider, active status
 * @returns List of merchant accounts (credentials NOT decrypted)
 */
export async function getMerchantAccounts(filters?: { providerId?: string; active?: boolean }) {
  const where: any = {}

  if (filters?.providerId) {
    where.providerId = filters.providerId
  }

  if (filters?.active !== undefined) {
    where.active = filters.active
  }

  const accounts = await prisma.merchantAccount.findMany({
    where,
    include: {
      provider: {
        select: {
          id: true,
          code: true,
          name: true,
          type: true,
        },
      },
      // Multi-account AngelPay: expose the linked AngelPayUserAccount email
      // so the dashboard's edit-merchant dialog can show "Cuenta vinculada:
      // contacto@avoqado.io" instead of the raw FK id. Only AngelPay
      // merchants have this populated; other providers ignore it.
      angelpayUserAccount: {
        select: { id: true, email: true, status: true, environment: true, venueId: true },
      },
      venueConfigsPrimary: {
        select: { venue: { select: { id: true, name: true, slug: true } } },
      },
      venueConfigsSecondary: {
        select: { venue: { select: { id: true, name: true, slug: true } } },
      },
      venueConfigsTertiary: {
        select: { venue: { select: { id: true, name: true, slug: true } } },
      },
      _count: {
        select: {
          costStructures: true,
          venueConfigsPrimary: true,
          venueConfigsSecondary: true,
          venueConfigsTertiary: true,
        },
      },
    },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
  })

  // Get terminals for each merchant account (with serial numbers)
  // Since assignedMerchantIds is a String[] array, we can't use Prisma _count
  const accountIds = accounts.map(a => a.id)
  const terminalsWithMerchants = await prisma.terminal.findMany({
    where: {
      assignedMerchantIds: {
        hasSome: accountIds,
      },
    },
    select: {
      id: true,
      serialNumber: true,
      assignedMerchantIds: true,
    },
  })

  // Build a map of merchantAccountId -> terminal details
  const terminalsByMerchant: Record<string, Array<{ id: string; serialNumber: string }>> = {}
  for (const terminal of terminalsWithMerchants) {
    for (const merchantId of terminal.assignedMerchantIds) {
      if (accountIds.includes(merchantId)) {
        if (!terminalsByMerchant[merchantId]) terminalsByMerchant[merchantId] = []
        terminalsByMerchant[merchantId].push({ id: terminal.id, serialNumber: terminal.serialNumber || '' })
      }
    }
  }

  // Remove encrypted credentials from response for security
  // Include venue names and terminal serials for the table UI
  const sanitizedAccounts = accounts.map(account => {
    // Deduplicate venues across primary/secondary/tertiary configs
    const venueMap = new Map<string, { id: string; name: string; slug: string }>()
    for (const vc of [...account.venueConfigsPrimary, ...account.venueConfigsSecondary, ...account.venueConfigsTertiary]) {
      venueMap.set(vc.venue.id, vc.venue)
    }

    const terminals = terminalsByMerchant[account.id] || []

    return {
      ...account,
      credentialsEncrypted: undefined, // Don't expose encrypted data
      venueConfigsPrimary: undefined,
      venueConfigsSecondary: undefined,
      venueConfigsTertiary: undefined,
      hasCredentials: !!(account.credentialsEncrypted as any)?.encrypted,
      venues: Array.from(venueMap.values()),
      terminals: terminals.map(t => ({ id: t.id, serialNumber: t.serialNumber })),
      _count: {
        costStructures: account._count.costStructures,
        venueConfigs: account._count.venueConfigsPrimary + account._count.venueConfigsSecondary + account._count.venueConfigsTertiary,
        terminals: terminals.length,
      },
    }
  })

  logger.info('Retrieved merchant accounts', {
    count: accounts.length,
    filters,
  })

  return sanitizedAccounts
}

/**
 * Get a single merchant account by ID
 * @param id Merchant account ID
 * @param includeCredentials Whether to decrypt and include credentials (default: false)
 * @returns Merchant account
 */
export async function getMerchantAccount(id: string, includeCredentials: boolean = false) {
  const account = await prisma.merchantAccount.findUnique({
    where: { id },
    include: {
      provider: true,
      costStructures: {
        where: { active: true },
        orderBy: { effectiveFrom: 'desc' },
        take: 5,
      },
      _count: {
        select: {
          costStructures: true,
          venueConfigsPrimary: true,
          venueConfigsSecondary: true,
          venueConfigsTertiary: true,
        },
      },
    },
  })

  if (!account) {
    throw new NotFoundError(`Merchant account ${id} not found`)
  }

  let decryptedCredentials = null
  if (includeCredentials && account.credentialsEncrypted) {
    try {
      decryptedCredentials = decryptCredentials(account.credentialsEncrypted)
    } catch (error) {
      logger.error('Failed to decrypt merchant credentials', { accountId: id, error })
    }
  }

  logger.info('Retrieved merchant account', {
    accountId: id,
    providerId: account.providerId,
    includeCredentials,
  })

  // Compute total venue configs count
  const venueConfigsCount = account._count.venueConfigsPrimary + account._count.venueConfigsSecondary + account._count.venueConfigsTertiary

  return {
    ...account,
    _count: {
      costStructures: account._count.costStructures,
      venueConfigs: venueConfigsCount,
    },
    credentialsEncrypted: undefined, // Don't expose encrypted data
    credentials: decryptedCredentials, // Only if requested
    hasCredentials: !!(account.credentialsEncrypted as any)?.encrypted,
  }
}

/**
 * Create a new merchant account
 * @param data Merchant account creation data
 * @returns Created merchant account
 */
export async function createMerchantAccount(data: CreateMerchantAccountData) {
  // Validate provider exists
  const provider = await prisma.paymentProvider.findUnique({
    where: { id: data.providerId },
  })

  if (!provider) {
    throw new NotFoundError(`Payment provider ${data.providerId} not found`)
  }

  // 🆕 Task 10: device-compatibility gate (covers ANGELPAY + BLUMON).
  // Only runs when a venue is in scope. Unconstrained providers (STRIPE, etc.)
  // are a no-op inside the helper. Throws IncompatibleDeviceError (HTTP 409).
  if (data.venueId) {
    await assertVenueHasCompatibleTerminal(data.venueId, provider.code)
  }

  // 🆕 Task 10: AngelPay-specific branch.
  // AngelPay credentials live on AngelPayUserAccount (per-venue email+PIN), so
  // the MerchantAccount row stores only a placeholder. We additionally require:
  //   1. externalMerchantId is a numeric string (AngelPay MerchantOption.id is Int)
  //   2. An ACTIVE AngelPayUserAccount on the venue
  if (provider.code === 'ANGELPAY') {
    if (!data.venueId) {
      throw new ValidationError('AngelPay merchant accounts require a venueId')
    }
    if (!/^\d+$/.test(data.externalMerchantId)) {
      throw new ValidationError('AngelPay externalMerchantId must be a numeric string')
    }
    // Multi-account per venue (2026-05-18): venueId alone is no longer unique.
    // Require at least ONE active account on the venue; the dashboard form has
    // a per-account "Reservar slot"/discovery UX that links the eventual
    // MerchantAccount to the right AngelPay login via `angelpayUserAccountId`.
    const angelpayAccount = await prisma.angelPayUserAccount.findFirst({
      where: { venueId: data.venueId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    })
    if (!angelpayAccount) {
      throw new ValidationError(
        `Venue has no ACTIVE AngelPay user account; cannot create merchant accounts until at least one account is ACTIVE`,
      )
    }
    // Auth lives on AngelPayUserAccount; force placeholder credentials so the
    // downstream encryption step writes the standard { encrypted, iv } blob.
    data.credentials = {}
  }

  // Determine if this is a Blumon "pending" account (no credentials but has serial number)
  const isBlumonPendingAccount = provider.code === 'BLUMON' && data.blumonSerialNumber && !data.credentials

  // Validate required credential fields (provider-specific)
  // Blumon pending accounts can skip credentials - they'll be fetched via OAuth later
  if (!isBlumonPendingAccount) {
    if (!data.credentials) {
      throw new BadRequestError('Credentials object is required')
    }

    // Schema-driven validation: if the provider declares
    // `configSchema.credentialFields`, validate the submitted credentials
    // against that schema. This makes provider integration data-driven —
    // adding a new provider only requires defining its schema, no service
    // changes.
    const credentialFields = (provider.configSchema as any)?.credentialFields as
      | Array<{ key: string; label?: string; required?: boolean; pattern?: string; minLength?: number; maxLength?: number }>
      | undefined

    if (Array.isArray(credentialFields) && credentialFields.length > 0) {
      const errors: string[] = []
      for (const field of credentialFields) {
        const value = data.credentials[field.key]
        const isEmpty = value === undefined || value === null || value === ''
        const label = field.label || field.key

        if (field.required && isEmpty) {
          errors.push(`${label} es obligatorio`)
          continue
        }
        if (isEmpty) continue

        const stringValue = String(value)
        if (field.minLength != null && stringValue.length < field.minLength) {
          errors.push(`${label} debe tener al menos ${field.minLength} caracteres`)
        }
        if (field.maxLength != null && stringValue.length > field.maxLength) {
          errors.push(`${label} no puede exceder ${field.maxLength} caracteres`)
        }
        if (field.pattern && !new RegExp(field.pattern).test(stringValue)) {
          errors.push(`${label} tiene un formato inválido`)
        }
      }
      if (errors.length > 0) {
        throw new BadRequestError(`Credenciales inválidas para ${provider.name}: ${errors.join('; ')}`)
      }
    } else if (provider.code !== 'BLUMON' && provider.code !== 'ANGELPAY') {
      // Legacy fallback for providers without a configSchema (Menta, Stripe, etc.)
      // — keep the historical merchantId + apiKey requirement.
      // AngelPay is special-cased even without a configSchema because its
      // credentials are email + PIN (simpleLogin), not merchantId + apiKey.
      if (!data.credentials.merchantId || !data.credentials.apiKey) {
        throw new BadRequestError('Credentials must include merchantId and apiKey')
      }
    }
  }

  // Check if account with same externalMerchantId already exists for this provider
  const existingAccount = await prisma.merchantAccount.findFirst({
    where: {
      providerId: data.providerId,
      externalMerchantId: data.externalMerchantId,
    },
    include: { provider: true },
  })

  if (existingAccount) {
    throw new BadRequestError(
      `Ya existe una cuenta con el ID "${data.externalMerchantId}" para el procesador ${existingAccount.provider?.name || 'seleccionado'}. ` +
        `Usa un ID diferente o elimina la cuenta existente primero.`,
    )
  }

  // Check if account with same serial number already exists for this provider
  // This prevents the TPV payment bug where two merchants with same serial but different posIds
  // cause RSA data mismatch and NullPointerException during payment
  if (data.blumonSerialNumber) {
    const existingSerial = await prisma.merchantAccount.findFirst({
      where: {
        providerId: data.providerId,
        blumonSerialNumber: data.blumonSerialNumber,
      },
      include: { provider: true },
    })

    if (existingSerial) {
      throw new BadRequestError(
        `Ya existe una cuenta con el número de serie "${data.blumonSerialNumber}" para el procesador ${existingSerial.provider?.name || 'seleccionado'}. ` +
          `Cada terminal solo puede tener una cuenta por procesador. Elimina la cuenta existente primero o usa un serial diferente.`,
      )
    }
  }

  // Encrypt credentials (or use empty placeholder for pending accounts)
  const encryptedCredentials = data.credentials ? encryptCredentials(data.credentials) : encryptCredentials({ pending: true })

  // Create merchant account
  const account = await prisma.merchantAccount.create({
    data: {
      providerId: data.providerId,
      externalMerchantId: data.externalMerchantId,
      alias: data.alias,
      displayName: data.displayName,
      active: data.active !== undefined ? data.active : true,
      displayOrder: data.displayOrder || 0,
      credentialsEncrypted: encryptedCredentials,
      providerConfig: data.providerConfig || null,
      // Blumon-specific fields
      blumonSerialNumber: data.blumonSerialNumber || null,
      blumonPosId: data.blumonPosId || null,
      blumonEnvironment: data.blumonEnvironment || null,
      blumonMerchantId: data.blumonMerchantId || null,
      // Bank account fields
      clabeNumber: data.clabeNumber || null,
      bankName: data.bankName || null,
      accountHolder: data.accountHolder || null,
    },
    include: {
      provider: true,
    },
  })

  logger.info('Merchant account created', {
    accountId: account.id,
    providerId: account.providerId,
    providerCode: provider.code,
    externalMerchantId: account.externalMerchantId,
    blumonSerialNumber: account.blumonSerialNumber,
    blumonPosId: account.blumonPosId,
    isBlumonPendingAccount,
  })

  return {
    ...account,
    credentialsEncrypted: undefined, // Don't expose encrypted data
    hasCredentials: !isBlumonPendingAccount, // Pending accounts don't have real credentials yet
    isPendingAffiliation: isBlumonPendingAccount,
  }
}

/**
 * Update a merchant account
 * @param id Merchant account ID
 * @param data Update data
 * @returns Updated merchant account
 */
export async function updateMerchantAccount(id: string, data: UpdateMerchantAccountData) {
  // Check if account exists
  const existingAccount = await prisma.merchantAccount.findUnique({
    where: { id },
  })

  if (!existingAccount) {
    throw new NotFoundError(`Merchant account ${id} not found`)
  }

  // Handle credential updates
  let updatedCredentials = existingAccount.credentialsEncrypted
  if (data.credentials) {
    // Decrypt existing credentials
    const currentCredentials = decryptCredentials(existingAccount.credentialsEncrypted)

    // Merge with updates
    const mergedCredentials = {
      ...currentCredentials,
      ...data.credentials,
    }

    // Re-encrypt
    updatedCredentials = encryptCredentials(mergedCredentials)
  }

  const updateData: any = {}

  if (data.externalMerchantId) updateData.externalMerchantId = data.externalMerchantId
  if (data.alias !== undefined) updateData.alias = data.alias
  if (data.displayName !== undefined) updateData.displayName = data.displayName
  if (data.active !== undefined) updateData.active = data.active
  if (data.displayOrder !== undefined) updateData.displayOrder = data.displayOrder
  if (data.credentials) updateData.credentialsEncrypted = updatedCredentials
  if (data.providerConfig !== undefined) updateData.providerConfig = data.providerConfig

  const account = await prisma.merchantAccount.update({
    where: { id },
    data: updateData,
    include: {
      provider: true,
    },
  })

  logger.info('Merchant account updated', {
    accountId: id,
    updates: Object.keys(data),
    credentialsUpdated: !!data.credentials,
  })

  // 🔔 Layer 1: Push notification to affected terminals via Socket.IO
  // Non-blocking - terminals will sync via heartbeat (Layer 2) if this fails
  notifyAffectedTerminals(
    id,
    account.displayName || account.alias || account.externalMerchantId,
    'MERCHANT_UPDATED',
    false, // Not urgent - terminal can refresh when convenient
  ).catch(err => {
    logger.error('Failed to notify terminals of merchant update (non-blocking)', { err })
  })

  return {
    ...account,
    credentialsEncrypted: undefined, // Don't expose encrypted data
    hasCredentials: true,
  }
}

/**
 * Toggle merchant account active status
 * @param id Merchant account ID
 * @returns Updated merchant account
 */
export async function toggleMerchantAccountStatus(id: string) {
  const account = await prisma.merchantAccount.findUnique({
    where: { id },
  })

  if (!account) {
    throw new NotFoundError(`Merchant account ${id} not found`)
  }

  const updated = await prisma.merchantAccount.update({
    where: { id },
    data: {
      active: !account.active,
    },
    include: {
      provider: true,
    },
  })

  logger.info('Merchant account status toggled', {
    accountId: id,
    newStatus: updated.active,
  })

  // 🔔 Layer 1: Push notification to affected terminals via Socket.IO
  // Status toggle is URGENT - merchant may have become inactive (can't accept payments)
  notifyAffectedTerminals(
    id,
    updated.displayName || updated.alias || updated.externalMerchantId,
    'MERCHANT_UPDATED',
    !updated.active, // Urgent if merchant was DEACTIVATED (can't accept payments anymore)
  ).catch(err => {
    logger.error('Failed to notify terminals of merchant status toggle (non-blocking)', { err })
  })

  return {
    ...updated,
    credentialsEncrypted: undefined,
    hasCredentials: true,
  }
}

/**
 * Delete a merchant account
 * Only allowed if no cost structures or venue configs reference it
 * @param id Merchant account ID
 */
export async function deleteMerchantAccount(id: string) {
  const account = await prisma.merchantAccount.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          costStructures: true,
          payments: true,
          transactionCosts: true,
        },
      },
    },
  })

  if (!account) {
    throw new NotFoundError(`Merchant account ${id} not found`)
  }

  // Check if account has processed payments (CRITICAL - cannot delete historical data)
  if (account._count.payments > 0) {
    throw new BadRequestError(
      `Cannot delete merchant account "${account.displayName || account.externalMerchantId}" because it has ${account._count.payments} payment(s) processed. ` +
        `Historical payment data must be preserved for compliance. Deactivate the account instead.`,
    )
  }

  // Check if account has transaction costs
  if (account._count.transactionCosts > 0) {
    throw new BadRequestError(
      `Cannot delete merchant account "${account.displayName || account.externalMerchantId}" because it has ${account._count.transactionCosts} transaction cost record(s). ` +
        `Deactivate the account instead.`,
    )
  }

  // Check if account is being used in venue configs
  const venueConfigs = await prisma.venuePaymentConfig.count({
    where: {
      OR: [{ primaryAccountId: id }, { secondaryAccountId: id }, { tertiaryAccountId: id }],
    },
  })

  if (account._count.costStructures > 0 || venueConfigs > 0) {
    throw new BadRequestError(
      `Cannot delete merchant account because it's in use (${account._count.costStructures} cost structures, ${venueConfigs} venue configs). Deactivate instead.`,
    )
  }

  // Check if any terminals have this merchant assigned
  const terminalsUsing = await prisma.terminal.count({
    where: {
      assignedMerchantIds: {
        has: id, // Check if array contains this merchant ID
      },
    },
  })

  if (terminalsUsing > 0) {
    const terminals = await prisma.terminal.findMany({
      where: { assignedMerchantIds: { has: id } },
      select: { name: true, serialNumber: true },
    })

    throw new BadRequestError(
      `Cannot delete merchant account "${account.displayName}" because it's assigned to ${terminalsUsing} terminal(s): ${terminals.map(t => `${t.name} (${t.serialNumber})`).join(', ')}. Remove assignments first.`,
    )
  }

  await prisma.merchantAccount.delete({
    where: { id },
  })

  logger.warn('Merchant account deleted', {
    accountId: id,
    externalMerchantId: account.externalMerchantId,
  })
}

/**
 * Get terminals that have a merchant account assigned
 * @param merchantAccountId Merchant account ID
 * @returns List of terminals using this merchant account
 */
export async function getTerminalsByMerchantAccount(merchantAccountId: string) {
  const terminals = await prisma.terminal.findMany({
    where: {
      assignedMerchantIds: {
        has: merchantAccountId,
      },
    },
    select: {
      id: true,
      name: true,
      serialNumber: true,
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  })

  return terminals
}

/**
 * Remove merchant account from a terminal's assignedMerchantIds
 * @param terminalId Terminal ID
 * @param merchantAccountId Merchant account ID to remove
 */
export async function removeMerchantFromTerminal(terminalId: string, merchantAccountId: string) {
  const terminal = await prisma.terminal.findUnique({
    where: { id: terminalId },
    select: { assignedMerchantIds: true, name: true, serialNumber: true },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal ${terminalId} not found`)
  }

  const updatedIds = terminal.assignedMerchantIds.filter(id => id !== merchantAccountId)

  await prisma.terminal.update({
    where: { id: terminalId },
    data: { assignedMerchantIds: updatedIds },
  })

  logger.info('Merchant account removed from terminal', {
    terminalId,
    terminalName: terminal.name,
    serialNumber: terminal.serialNumber,
    merchantAccountId,
  })

  return { success: true }
}

/**
 * Get decrypted credentials for a merchant account
 * SECURITY: Only use this for payment processing
 * @param id Merchant account ID
 * @returns Decrypted credentials
 */
export async function getDecryptedCredentials(id: string) {
  const account = await prisma.merchantAccount.findUnique({
    where: { id },
    select: {
      id: true,
      credentialsEncrypted: true,
      active: true,
    },
  })

  if (!account) {
    throw new NotFoundError(`Merchant account ${id} not found`)
  }

  if (!account.active) {
    throw new BadRequestError(`Merchant account ${id} is not active`)
  }

  const credentials = decryptCredentials(account.credentialsEncrypted)

  logger.info('Merchant credentials decrypted', {
    accountId: id,
  })

  return credentials
}

/**
 * Auto-create ProviderCostStructure when a MerchantAccount is created
 *
 * Uses MCC lookup to determine Blumon's rates based on:
 * 1. PRIORITY: venue.type (VenueType enum from onboarding) - most reliable
 * 2. FALLBACK: businessCategory (Giro) - manual input if venue.type doesn't match
 *
 * The rates from Blumon represent what Blumon charges Avoqado (our cost).
 *
 * @param merchantAccountId - The MerchantAccount ID to link to
 * @param providerId - The PaymentProvider ID (should be Blumon)
 * @param options.venueType - The venue's type enum (e.g., 'FITNESS', 'RESTAURANT') - PRIORITY
 * @param options.businessCategory - Manual business category/giro as fallback
 * @returns The created ProviderCostStructure or null if creation failed
 */
export async function autoCreateProviderCostStructure(
  merchantAccountId: string,
  providerId: string,
  options: {
    venueType?: string | null
    businessCategory?: string | null
  },
): Promise<{ costStructure: any; mccLookup: MCCLookupResult } | null> {
  try {
    // Check if a ProviderCostStructure already exists for this merchant
    const existing = await prisma.providerCostStructure.findFirst({
      where: {
        merchantAccountId,
        active: true,
      },
    })

    if (existing) {
      logger.info(`⚡ ProviderCostStructure already exists for merchant ${merchantAccountId}, skipping auto-create`)
      return null
    }

    // Determine MCC lookup strategy
    // PRIORITY: venueType (from onboarding) → businessCategory (manual fallback)
    let mccLookup: MCCLookupResult
    let lookupSource: string

    if (options.venueType) {
      // Use venueType first (more reliable, comes from onboarding)
      mccLookup = lookupRatesByVenueType(options.venueType)
      lookupSource = `venueType:${options.venueType}`
      logger.info(`🔍 MCC lookup using venueType: ${options.venueType}`, {
        found: mccLookup.found,
        familia: mccLookup.familia,
        confidence: mccLookup.confidence,
      })
    } else if (options.businessCategory) {
      // Fallback to manual businessCategory (giro)
      mccLookup = lookupRatesByBusinessName(options.businessCategory)
      lookupSource = `businessCategory:${options.businessCategory}`
      logger.info(`🔍 MCC lookup using businessCategory: ${options.businessCategory}`, {
        found: mccLookup.found,
        familia: mccLookup.familia,
        confidence: mccLookup.confidence,
      })
    } else {
      // No lookup source provided, use default rates
      mccLookup = lookupRatesByBusinessName('otros')
      lookupSource = 'default'
      logger.warn(`⚠️ No venueType or businessCategory provided, using default rates`)
    }

    if (!mccLookup.rates) {
      logger.warn(`❌ No rates found for ${lookupSource}`)
      return null
    }

    // Convert percentage rates (e.g., 1.70) to decimal rates (e.g., 0.0170)
    // MCC lookup returns rates as percentages like 1.70 for 1.70%
    // Database stores rates as decimals like 0.0170
    const rates = {
      debitRate: mccLookup.rates.debito / 100,
      creditRate: mccLookup.rates.credito / 100,
      amexRate: mccLookup.rates.amex / 100,
      internationalRate: mccLookup.rates.internacional / 100,
    }

    // Create ProviderCostStructure
    const costStructure = await prisma.providerCostStructure.create({
      data: {
        providerId,
        merchantAccountId,
        debitRate: rates.debitRate,
        creditRate: rates.creditRate,
        amexRate: rates.amexRate,
        internationalRate: rates.internationalRate,
        fixedCostPerTransaction: 0, // Blumon typically doesn't have fixed fees
        effectiveFrom: new Date(),
        active: true,
        proposalReference: `AUTO-MCC-${mccLookup.mcc || 'DEFAULT'}-${Date.now()}`,
        notes: `Auto-creado via MCC lookup (${lookupSource}). Familia: ${mccLookup.familia || 'Otros'}, Match: ${mccLookup.matchType || 'default'}, Confidence: ${mccLookup.confidence}%`,
      },
    })

    logger.info(`✅ Auto-created ProviderCostStructure for merchant ${merchantAccountId}`, {
      costStructureId: costStructure.id,
      lookupSource,
      venueType: options.venueType,
      businessCategory: options.businessCategory,
      familia: mccLookup.familia,
      mcc: mccLookup.mcc,
      confidence: mccLookup.confidence,
      rates: {
        debit: `${mccLookup.rates.debito}%`,
        credit: `${mccLookup.rates.credito}%`,
        amex: `${mccLookup.rates.amex}%`,
        international: `${mccLookup.rates.internacional}%`,
      },
    })

    return { costStructure, mccLookup }
  } catch (error) {
    logger.error(`Failed to auto-create ProviderCostStructure for merchant ${merchantAccountId}:`, error)
    return null
  }
}

/**
 * Get MCC rate suggestion for a business name
 *
 * This is used by the frontend to show suggested rates when creating a MerchantAccount.
 * The superadmin can accept these rates or modify them.
 *
 * @param businessName - The business name to lookup
 * @returns MCCLookupResult with rates and metadata
 */
export function getMccRateSuggestion(businessName: string): MCCLookupResult {
  return lookupRatesByBusinessName(businessName)
}

/**
 * Create MerchantAccount and auto-create ProviderCostStructure
 *
 * This is a convenience function that creates both in one call.
 * Used when creating a MerchantAccount for a specific venue.
 *
 * @param data - MerchantAccount creation data
 * @param options.venueType - Venue type enum for MCC lookup (PRIORITY)
 * @param options.businessCategory - Manual business category/giro as fallback
 * @returns Created MerchantAccount and optionally ProviderCostStructure
 */
export async function createMerchantAccountWithCostStructure(
  data: CreateMerchantAccountData,
  options?: {
    venueType?: string | null
    businessCategory?: string | null
  },
): Promise<{
  merchantAccount: any
  costStructure?: any
  mccLookup?: MCCLookupResult
}> {
  // Create the MerchantAccount
  const merchantAccount = await createMerchantAccount(data)

  // If venueType or businessCategory is provided, auto-create ProviderCostStructure
  if (options?.venueType || options?.businessCategory) {
    const result = await autoCreateProviderCostStructure(merchantAccount.id, data.providerId, {
      venueType: options.venueType,
      businessCategory: options.businessCategory,
    })

    if (result) {
      return {
        merchantAccount,
        costStructure: result.costStructure,
        mccLookup: result.mccLookup,
      }
    }
  }

  return { merchantAccount }
}

// ============================================================
// Option B workaround: AngelPay auto-discovery upsert
// ============================================================

/**
 * Single AngelPay merchant entry reported by TPV (mirrors SDK
 * MerchantOption / MerchantSummary shape).
 */
export interface DiscoveredAngelPayMerchant {
  angelpayId: number // SDK MerchantOption.id (Int)
  name: string
  affiliationNumber: string
  isActive: boolean // SDK's "currently selected" — informational only, NOT our `active`
}

/**
 * Idempotent upsert of merchants auto-discovered by TPV via
 * AngelPaySDK.getUserMerchants() after a successful auth.
 *
 * Key design notes:
 * - Upsert key: (providerId=ANGELPAY, externalMerchantId=String(angelpayId)),
 *   enforced by `@@unique([providerId, externalMerchantId])` on MerchantAccount.
 * - Existing rows: only refresh display fields (`angelpayAffiliation`,
 *   `angelpayMerchantName`). NEVER flip `active` — that respects admin
 *   approval decisions in the dashboard.
 * - New rows: created with `active: false` (PENDING_REVIEW). Admin must
 *   approve via dashboard to surface the merchant in the TPV.
 * - Bypasses the AngelPayUserAccount.status==ACTIVE gate from Task 10
 *   (manual createMerchantAccount): by the time TPV reaches this endpoint
 *   the SDK has already authenticated against AngelPay, so the user IS
 *   active by definition. Re-asserting here would just create a circular
 *   chicken-and-egg failure on first onboarding.
 * - NOTE: MerchantAccount has no direct `venueId` column — the
 *   Venue ↔ MerchantAccount link lives in VenuePaymentConfig (primary /
 *   secondary / tertiary slots). Auto-discovered rows are added to the
 *   global merchant pool with `active=false` and become routable only
 *   after an admin both approves them (sets `active=true`) and wires them
 *   into a VenuePaymentConfig slot. `input.venueId` is accepted purely
 *   for audit/logging.
 */
export async function upsertDiscoveredAngelPayMerchants(input: {
  venueId: string
  merchants: DiscoveredAngelPayMerchant[]
  /**
   * Optional — when provided, the upsert links new MerchantAccount rows (and
   * upgraded placeholders) to this AngelPayUserAccount via the
   * `angelpayUserAccountId` FK. Required for the TPV's `switchAccount(accountId)`
   * flow when a venue has more than one AngelPay login: without the link, the
   * cashier-side merchant picker can't route back to "which AngelPay account
   * owns this merchant?".
   *
   * Existing rows are NOT re-linked — operators can manually re-attribute
   * via the dashboard if discovery first happened under a different account.
   */
  angelpayUserAccountId?: string
}): Promise<{ created: number; updated: number; skipped: number }> {
  const angelpayProvider = await prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } })
  if (!angelpayProvider) {
    throw new NotFoundError('PaymentProvider ANGELPAY not found — was seed.ts run?')
  }

  let created = 0
  let updated = 0
  let skipped = 0

  for (const m of input.merchants) {
    if (!Number.isInteger(m.angelpayId) || m.angelpayId <= 0) {
      logger.warn('Skipping invalid AngelPay merchant ID in auto-discovery', {
        angelpayId: m.angelpayId,
        venueId: input.venueId,
      })
      skipped++
      continue
    }

    const externalMerchantId = String(m.angelpayId)
    // Multi-account uniqueness (2026-05-19): the row is keyed by
    // (providerId, externalMerchantId, angelpayUserAccountId), so the same
    // AngelPay merchant CAN exist multiple times in the DB — once per
    // AngelPay user account that has access to it. Each row gets its own
    // VenuePaymentConfig slot, its own ProviderCostStructure, and its own
    // dashboard card. This replaces the prior orphan-placeholder-cleanup
    // hack (2026-05-19, removed) which merged shared merchants into a
    // single row and made the second account inert for that merchant.
    const existing = await prisma.merchantAccount.findFirst({
      where: {
        providerId: angelpayProvider.id,
        externalMerchantId,
        angelpayUserAccountId: input.angelpayUserAccountId ?? null,
      },
    })

    if (existing) {
      await prisma.merchantAccount.update({
        where: { id: existing.id },
        data: {
          angelpayAffiliation: m.affiliationNumber,
          angelpayMerchantName: m.name,
          // Intentionally NOT touching `active` — respects admin approval.
        },
      })
      updated++
    } else {
      // Placeholder upgrade path: if admin reserved a slot from the dashboard,
      // there's a MerchantAccount in this venue with externalMerchantId like
      // `AWAITING_<venueId>_*`. Upgrade THIS account's placeholder first if
      // one exists (multi-account safety — without the `angelpayUserAccountId`
      // filter the query would grab ANY placeholder in the venue and upgrade
      // the wrong account's reserved slot). Fall back to "any placeholder in
      // venue" only when no account-scoped match exists, preserving the
      // single-account legacy behavior.
      const placeholderQuery = {
        providerId: angelpayProvider.id,
        externalMerchantId: { startsWith: `AWAITING_${input.venueId}_` },
      }
      const placeholderInVenue = input.angelpayUserAccountId
        ? ((await prisma.merchantAccount.findFirst({
            where: { ...placeholderQuery, angelpayUserAccountId: input.angelpayUserAccountId },
            orderBy: { createdAt: 'asc' },
          })) ??
          (await prisma.merchantAccount.findFirst({
            where: { ...placeholderQuery, angelpayUserAccountId: null },
            orderBy: { createdAt: 'asc' },
          })))
        : await prisma.merchantAccount.findFirst({
            where: placeholderQuery,
            orderBy: { createdAt: 'asc' },
          })

      if (placeholderInVenue) {
        await prisma.merchantAccount.update({
          where: { id: placeholderInVenue.id },
          data: {
            externalMerchantId, // Replace AWAITING_xxx with the real numeric ID
            displayName: m.name,
            active: true,
            angelpayAffiliation: m.affiliationNumber,
            angelpayMerchantName: m.name,
            ...(input.angelpayUserAccountId && { angelpayUserAccountId: input.angelpayUserAccountId }),
          },
        })
        logger.info('Placeholder upgraded with discovered merchant data', {
          venueId: input.venueId,
          placeholderId: placeholderInVenue.id,
          oldExternalId: placeholderInVenue.externalMerchantId,
          newExternalId: externalMerchantId,
          angelpayId: m.angelpayId,
        })
        created++
        continue
      }

      // No placeholder available — zero-touch auto-onboarding: create the
      // merchant as active + atomically attach to the venue's first empty
      // VenuePaymentConfig slot. Without the slot attachment, the new merchant
      // exists in DB but isn't routable from the TPV (the
      // /tpv/terminals/:serial/config endpoint only returns merchants assigned
      // to a slot). Without active=true, the dashboard MerchantAccounts page
      // hides them by default and admins can't tell anything happened.
      await prisma.$transaction(async tx => {
        const newAccount = await tx.merchantAccount.create({
          data: {
            providerId: angelpayProvider.id,
            externalMerchantId,
            displayName: m.name,
            active: true, // Auto-approved — TPV already authenticated successfully
            credentialsEncrypted: encryptCredentials({}), // placeholder (auth lives on AngelPayUserAccount)
            angelpayAffiliation: m.affiliationNumber,
            angelpayMerchantName: m.name,
            ...(input.angelpayUserAccountId && { angelpayUserAccountId: input.angelpayUserAccountId }),
          },
        })

        // Pick the first empty VenuePaymentConfig slot for this venue.
        // PRIMARY slot in the schema is non-null, so if no config row exists we
        // must create it with the new merchant in primary. Otherwise we update
        // the first empty slot (secondary → tertiary).
        const existingConfig = await tx.venuePaymentConfig.findUnique({
          where: { venueId: input.venueId },
        })
        if (!existingConfig) {
          await tx.venuePaymentConfig.create({
            data: {
              venueId: input.venueId,
              primaryAccountId: newAccount.id,
            },
          })
          logger.info('Auto-assigned to PRIMARY (new VenuePaymentConfig)', {
            venueId: input.venueId,
            merchantAccountId: newAccount.id,
            angelpayId: m.angelpayId,
          })
        } else if (!existingConfig.secondaryAccountId) {
          await tx.venuePaymentConfig.update({
            where: { venueId: input.venueId },
            data: { secondaryAccountId: newAccount.id },
          })
          logger.info('Auto-assigned to SECONDARY', {
            venueId: input.venueId,
            merchantAccountId: newAccount.id,
            angelpayId: m.angelpayId,
          })
        } else if (!existingConfig.tertiaryAccountId) {
          await tx.venuePaymentConfig.update({
            where: { venueId: input.venueId },
            data: { tertiaryAccountId: newAccount.id },
          })
          logger.info('Auto-assigned to TERTIARY', {
            venueId: input.venueId,
            merchantAccountId: newAccount.id,
            angelpayId: m.angelpayId,
          })
        } else {
          // All 3 slots full — leave the merchant active but unassigned.
          // Admin must manually reassign via the approve endpoint to make it
          // routable. Log a clear warning so this scenario is observable.
          logger.warn('All VenuePaymentConfig slots full — merchant created but NOT assigned', {
            venueId: input.venueId,
            merchantAccountId: newAccount.id,
            angelpayId: m.angelpayId,
            primaryAccountId: existingConfig.primaryAccountId,
            secondaryAccountId: existingConfig.secondaryAccountId,
            tertiaryAccountId: existingConfig.tertiaryAccountId,
          })
        }
      })
      created++
    }
  }

  // Auto-bind every active AngelPay MerchantAccount linked to this venue
  // (via VenuePaymentConfig slots or angelpayUserAccountId scoped to this
  // venue) into every NEXGO terminal's `assignedMerchantIds`. Idempotent —
  // skips merchants already attached. Mirrors Blumon's serial-based terminal
  // attachment (Terminal.assignedMerchantIds is the routing signal the
  // dashboard reads to show the "X terminales" badge, and the TPV config
  // endpoint uses to filter merchants per terminal). Without this, AngelPay
  // merchants only flow through the venue-level VenuePaymentConfig slot →
  // dashboard shows "no terminal count" → operator thinks "not connected"
  // and cashier can't tell which merchants the current terminal can charge.
  // Runs after the main upsert loop so it covers all 3 paths (existing
  // update / placeholder upgrade / new create) uniformly.
  try {
    const nexgoTerminals = await prisma.terminal.findMany({
      where: { venueId: input.venueId, brand: 'NEXGO' },
      select: { id: true, serialNumber: true, assignedMerchantIds: true },
    })
    if (nexgoTerminals.length > 0) {
      // Find every active ANGELPAY MerchantAccount routable in this venue.
      // Scoped to (a) merchants linked to one of this venue's AngelPay accounts
      // OR (b) merchants attached to this venue's VenuePaymentConfig slots —
      // covers both multi-account (FK link) and legacy single-account (slot)
      // wiring without leaking other venues' AngelPay merchants in.
      const venueConfig = await prisma.venuePaymentConfig.findUnique({
        where: { venueId: input.venueId },
        select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
      })
      const slotIds = [venueConfig?.primaryAccountId, venueConfig?.secondaryAccountId, venueConfig?.tertiaryAccountId].filter(
        (x): x is string => !!x,
      )

      const venueAccountIds = await prisma.angelPayUserAccount.findMany({
        where: { venueId: input.venueId },
        select: { id: true },
      })

      const venueAngelpayMerchants = await prisma.merchantAccount.findMany({
        where: {
          providerId: angelpayProvider.id,
          active: true,
          OR: [{ id: { in: slotIds } }, { angelpayUserAccountId: { in: venueAccountIds.map(a => a.id) } }],
        },
        select: { id: true, externalMerchantId: true },
      })

      let boundCount = 0
      for (const term of nexgoTerminals) {
        const missing = venueAngelpayMerchants.filter(ma => !term.assignedMerchantIds.includes(ma.id)).map(ma => ma.id)
        if (missing.length === 0) continue
        await prisma.terminal.update({
          where: { id: term.id },
          data: { assignedMerchantIds: { push: missing } },
        })
        boundCount += missing.length
      }
      if (boundCount > 0) {
        logger.info('Auto-bound AngelPay merchants to NEXGO terminals', {
          venueId: input.venueId,
          terminalsTouched: nexgoTerminals.length,
          merchantAttachments: boundCount,
        })
      }
    }
  } catch (err) {
    // Non-fatal — discovery still counts as successful even if attachment
    // hiccups (operator can manually attach via dashboard). Logs the error
    // so we can monitor for systemic failures.
    logger.warn('Auto-bind AngelPay merchants to NEXGO terminals failed', {
      venueId: input.venueId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  logger.info('AngelPay auto-discovered merchants upserted', {
    venueId: input.venueId,
    created,
    updated,
    skipped,
    total: input.merchants.length,
  })

  return { created, updated, skipped }
}

// ============================================================================
// Option B closure: approve auto-discovered AngelPay merchant + auto-attach
// to a VenuePaymentConfig slot in one atomic operation (mirrors Blumon's
// auto-attach pattern, but targets VenuePaymentConfig slots instead of the
// Terminal.assignedMerchantIds bag because AngelPay is intent-routed and
// terminal-agnostic).
// ============================================================================

export type VenuePaymentSlot = 'PRIMARY' | 'SECONDARY' | 'TERTIARY'

const SLOT_TO_COLUMN: Record<VenuePaymentSlot, 'primaryAccountId' | 'secondaryAccountId' | 'tertiaryAccountId'> = {
  PRIMARY: 'primaryAccountId',
  SECONDARY: 'secondaryAccountId',
  TERTIARY: 'tertiaryAccountId',
}

/**
 * Approve an auto-discovered AngelPay MerchantAccount AND wire it into a
 * VenuePaymentConfig slot in a single transaction.
 *
 * Mirrors the spirit of Blumon's auto-attach (Blumon attaches a freshly
 * fetched MerchantAccount to Terminals with matching serials in the same
 * controller flow). For AngelPay, the equivalent "where does this routable
 * thing live" is the VenuePaymentConfig (PRIMARY/SECONDARY/TERTIARY), so
 * approval = flip `active=true` + write the chosen slot in one shot.
 *
 * Semantics:
 *  - Validates the MerchantAccount is providerCode=ANGELPAY and currently
 *    inactive (PENDING_REVIEW). Refuses to "re-approve" an active one (no-op).
 *  - Validates the venue exists.
 *  - Inside a single `prisma.$transaction`:
 *      1. Update MerchantAccount.active = true
 *      2. Upsert VenuePaymentConfig for the venue, writing only the chosen
 *         slot. If no config exists, create one with this merchant in the
 *         chosen slot (when slot=SECONDARY or TERTIARY, that is impossible
 *         because primaryAccountId is non-null in the schema — we surface a
 *         clear 400 error in that edge case instead of silently demoting to
 *         primary).
 *      3. If the chosen slot is already occupied by a *different* merchant,
 *         throw ConflictError (409) — operator must choose another slot or
 *         unassign the incumbent first.
 *
 * Returns the updated MerchantAccount + the resulting VenuePaymentConfig.
 */
export async function approveDiscoveredAngelPayMerchant(input: {
  venueId: string
  merchantAccountId: string
  slot: VenuePaymentSlot
  /**
   * Optional per-terminal scoping. When non-empty, the merchant is pushed onto
   * each `Terminal.assignedMerchantIds` (idempotent) so the TPV config endpoint
   * only surfaces this merchant on the listed terminals. When omitted or empty,
   * the merchant is available on every venue terminal via VenuePaymentConfig
   * inheritance (Terminal.assignedMerchantIds=[] → fallback path).
   */
  terminalIds?: string[]
}): Promise<{
  merchantAccount: Awaited<ReturnType<typeof prisma.merchantAccount.findUnique>>
  venuePaymentConfig: Awaited<ReturnType<typeof prisma.venuePaymentConfig.findUnique>>
}> {
  const { venueId, merchantAccountId, slot, terminalIds } = input

  // ---- Pre-flight validation (outside transaction so errors don't roll back nothing) ----
  const venue = await prisma.venue.findUnique({ where: { id: venueId } })
  if (!venue) {
    throw new NotFoundError(`Venue ${venueId} not found`)
  }

  const merchantAccount = await prisma.merchantAccount.findUnique({
    where: { id: merchantAccountId },
    include: { provider: true },
  })
  if (!merchantAccount) {
    throw new NotFoundError(`MerchantAccount ${merchantAccountId} not found`)
  }
  if (merchantAccount.provider.code !== 'ANGELPAY') {
    throw new BadRequestError(
      `MerchantAccount ${merchantAccountId} is not an AngelPay merchant (provider=${merchantAccount.provider.code})`,
    )
  }
  if (merchantAccount.active) {
    throw new BadRequestError(`MerchantAccount ${merchantAccountId} is already active — nothing to approve`)
  }

  const slotColumn = SLOT_TO_COLUMN[slot]
  if (!slotColumn) {
    throw new BadRequestError(`Invalid slot "${slot}" — must be PRIMARY, SECONDARY, or TERTIARY`)
  }

  // ---- Transaction: flip active + assign slot ----
  const result = await prisma.$transaction(async tx => {
    const updatedMerchant = await tx.merchantAccount.update({
      where: { id: merchantAccountId },
      data: { active: true },
      include: { provider: true },
    })

    const existingConfig = await tx.venuePaymentConfig.findUnique({
      where: { venueId },
    })

    let updatedConfig

    if (!existingConfig) {
      // No config exists — must create one. Schema requires primaryAccountId,
      // so we can only create from scratch when slot=PRIMARY. Otherwise refuse
      // with a clear message instead of silently demoting.
      if (slot !== 'PRIMARY') {
        throw new BadRequestError(`Venue ${venueId} has no payment config yet — first approval must target the PRIMARY slot to seed it.`)
      }
      updatedConfig = await tx.venuePaymentConfig.create({
        data: {
          venueId,
          primaryAccountId: merchantAccountId,
          routingRules: {},
          preferredProcessor: 'AUTO',
        },
        include: {
          primaryAccount: { include: { provider: true } },
          secondaryAccount: { include: { provider: true } },
          tertiaryAccount: { include: { provider: true } },
        },
      })
    } else {
      // Conflict check: slot occupied by a *different* merchant?
      const occupantId = (existingConfig as any)[slotColumn] as string | null | undefined
      if (occupantId && occupantId !== merchantAccountId) {
        throw new ConflictError(
          `Slot ${slot} is already occupied by another merchant (${occupantId}). ` +
            `Choose another slot or unassign the current merchant first.`,
        )
      }
      updatedConfig = await tx.venuePaymentConfig.update({
        where: { venueId },
        data: { [slotColumn]: merchantAccountId },
        include: {
          primaryAccount: { include: { provider: true } },
          secondaryAccount: { include: { provider: true } },
          tertiaryAccount: { include: { provider: true } },
        },
      })
    }

    // ---- Optional per-terminal scoping ----
    // Empty/undefined `terminalIds` means "no per-terminal restriction" — the
    // terminal config endpoint falls back to VenuePaymentConfig inheritance
    // when `Terminal.assignedMerchantIds` is empty. Non-empty means "restrict
    // to these terminals only" — we push the merchant id to each terminal's
    // assignedMerchantIds (idempotent: skip if already present).
    if (terminalIds && terminalIds.length > 0) {
      for (const terminalId of terminalIds) {
        const terminal = await tx.terminal.findUnique({
          where: { id: terminalId },
          select: { id: true, venueId: true, assignedMerchantIds: true },
        })
        if (!terminal) {
          throw new BadRequestError(`Terminal ${terminalId} not found`)
        }
        if (terminal.venueId !== venueId) {
          throw new BadRequestError(`Terminal ${terminalId} does not belong to venue ${venueId}`)
        }
        // Task 11 — brand-compat guard. Rejects e.g. PAX terminal + ANGELPAY merchant.
        await assertMerchantTerminalCompatible(terminalId, merchantAccountId, tx)

        const current = terminal.assignedMerchantIds ?? []
        if (!current.includes(merchantAccountId)) {
          await tx.terminal.update({
            where: { id: terminalId },
            data: { assignedMerchantIds: { set: [...current, merchantAccountId] } },
          })
        }
      }
    }

    return { merchantAccount: updatedMerchant, venuePaymentConfig: updatedConfig }
  })

  logger.info('AngelPay discovered merchant approved + assigned to venue slot', {
    event: 'angelpay.discovered_merchant_approved',
    venueId,
    merchantAccountId,
    slot,
    externalMerchantId: merchantAccount.externalMerchantId,
    terminalIds: terminalIds && terminalIds.length > 0 ? terminalIds : undefined,
  })

  return result
}

// ============================================================================
// Placeholder reservation flow: admin reserves a VenuePaymentConfig slot for
// an AngelPay merchant WITHOUT having the real Merchant ID / Affiliation
// numbers (those come from AngelPay/TPV). When the TPV authenticates and
// reports the discovered merchants, `upsertDiscoveredAngelPayMerchants`
// detects the AWAITING placeholder and UPDATES it with the real IDs instead
// of creating a duplicate row.
// ============================================================================

export async function reserveAngelPaySlot(input: {
  venueId: string
  slot?: VenuePaymentSlot
  displayName?: string
  /**
   * Optional — when the admin knows up-front which AngelPay login should own
   * the merchant (multi-account venue: dashboard offers a per-account
   * "reservar slot" button), link the placeholder to that account so the
   * subsequent discovery upgrade lands on the correct AngelPay user. When
   * omitted, the placeholder is unlinked and the next discovery run that
   * matches it lazily back-fills the FK.
   */
  angelpayUserAccountId?: string
}): Promise<{ merchantAccountId: string; slot: VenuePaymentSlot; externalMerchantId: string }> {
  const angelpayProvider = await prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } })
  if (!angelpayProvider) {
    throw new NotFoundError('PaymentProvider ANGELPAY not found — was seed.ts run?')
  }

  // Synthetic externalMerchantId that includes venueId for fast lookup later
  // (see upsertDiscoveredAngelPayMerchants placeholder match).
  const placeholderExternalId = `AWAITING_${input.venueId}_${Date.now()}`

  return prisma.$transaction(async tx => {
    const placeholder = await tx.merchantAccount.create({
      data: {
        providerId: angelpayProvider.id,
        externalMerchantId: placeholderExternalId,
        displayName: input.displayName || 'AngelPay (esperando TPV)',
        active: false, // Becomes true when TPV discovery upgrades the placeholder
        credentialsEncrypted: encryptCredentials({}),
        angelpayAffiliation: 'PENDING',
        angelpayMerchantName: input.displayName || 'Pendiente',
        ...(input.angelpayUserAccountId && { angelpayUserAccountId: input.angelpayUserAccountId }),
      },
    })

    // Pick the slot: admin-specified, or first empty if not specified.
    const existingConfig = await tx.venuePaymentConfig.findUnique({
      where: { venueId: input.venueId },
    })

    let assignedSlot: VenuePaymentSlot
    if (!existingConfig) {
      // No config exists — create with the placeholder in primary (only slot
      // legal at creation since primaryAccountId is non-null).
      await tx.venuePaymentConfig.create({
        data: { venueId: input.venueId, primaryAccountId: placeholder.id },
      })
      assignedSlot = 'PRIMARY'
    } else if (input.slot) {
      // Admin specified a slot — honor it if empty, throw otherwise.
      const slotColumn = SLOT_TO_COLUMN[input.slot]
      const currentOccupant = (existingConfig as any)[slotColumn]
      if (currentOccupant) {
        throw new ConflictError(`El slot ${input.slot} ya está ocupado. Escoge otro slot o libéralo primero.`)
      }
      await tx.venuePaymentConfig.update({
        where: { venueId: input.venueId },
        data: { [slotColumn]: placeholder.id },
      })
      assignedSlot = input.slot
    } else {
      // Auto-pick first empty slot (skipping PRIMARY since it's non-null,
      // it's already taken by something).
      if (!existingConfig.secondaryAccountId) {
        await tx.venuePaymentConfig.update({
          where: { venueId: input.venueId },
          data: { secondaryAccountId: placeholder.id },
        })
        assignedSlot = 'SECONDARY'
      } else if (!existingConfig.tertiaryAccountId) {
        await tx.venuePaymentConfig.update({
          where: { venueId: input.venueId },
          data: { tertiaryAccountId: placeholder.id },
        })
        assignedSlot = 'TERTIARY'
      } else {
        throw new ConflictError('Los 3 slots del venue están ocupados. Libera uno antes de reservar.')
      }
    }

    logger.info('AngelPay slot reserved (placeholder created)', {
      venueId: input.venueId,
      merchantAccountId: placeholder.id,
      slot: assignedSlot,
      externalMerchantId: placeholderExternalId,
    })

    return {
      merchantAccountId: placeholder.id,
      slot: assignedSlot,
      externalMerchantId: placeholderExternalId,
    }
  })
}
