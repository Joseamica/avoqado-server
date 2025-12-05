import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import crypto from 'crypto'
import socketManager from '../../communication/sockets'

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
function encryptCredentials(credentials: any): any {
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
function decryptCredentials(encryptedData: any): any {
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
async function notifyAffectedTerminals(
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
  credentials: {
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

  // Remove encrypted credentials from response for security
  // Also compute total venue configs count
  const sanitizedAccounts = accounts.map(account => ({
    ...account,
    credentialsEncrypted: undefined, // Don't expose encrypted data
    hasCredentials: !!(account.credentialsEncrypted as any)?.encrypted,
    _count: {
      costStructures: account._count.costStructures,
      venueConfigs: account._count.venueConfigsPrimary + account._count.venueConfigsSecondary + account._count.venueConfigsTertiary,
    },
  }))

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

  // Validate required credential fields (provider-specific)
  // Blumon uses OAuth tokens instead of merchantId/apiKey
  if (provider.code !== 'BLUMON') {
    if (!data.credentials.merchantId || !data.credentials.apiKey) {
      throw new BadRequestError('Credentials must include merchantId and apiKey')
    }
  }

  // Encrypt credentials
  const encryptedCredentials = encryptCredentials(data.credentials)

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
  })

  return {
    ...account,
    credentialsEncrypted: undefined, // Don't expose encrypted data
    hasCredentials: true,
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
        },
      },
    },
  })

  if (!account) {
    throw new NotFoundError(`Merchant account ${id} not found`)
  }

  // Check if account is being used
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
