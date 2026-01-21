import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import crypto from 'crypto'
import socketManager from '../../communication/sockets'
import { lookupRatesByBusinessName, lookupRatesByVenueType, type MCCLookupResult } from '../pricing/blumon-mcc-lookup.service'

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

  // Get terminal counts for each merchant account
  // Since assignedMerchantIds is a String[] array, we can't use Prisma _count
  // We need to count terminals where the account ID is in the array
  const accountIds = accounts.map(a => a.id)
  const terminalsWithMerchants = await prisma.terminal.findMany({
    where: {
      assignedMerchantIds: {
        hasSome: accountIds,
      },
    },
    select: {
      id: true,
      assignedMerchantIds: true,
    },
  })

  // Build a map of merchantAccountId -> terminal count
  const terminalCountByMerchant: Record<string, number> = {}
  for (const terminal of terminalsWithMerchants) {
    for (const merchantId of terminal.assignedMerchantIds) {
      if (accountIds.includes(merchantId)) {
        terminalCountByMerchant[merchantId] = (terminalCountByMerchant[merchantId] || 0) + 1
      }
    }
  }

  // Remove encrypted credentials from response for security
  // Also compute total venue configs count and terminals count
  const sanitizedAccounts = accounts.map(account => ({
    ...account,
    credentialsEncrypted: undefined, // Don't expose encrypted data
    hasCredentials: !!(account.credentialsEncrypted as any)?.encrypted,
    _count: {
      costStructures: account._count.costStructures,
      venueConfigs: account._count.venueConfigsPrimary + account._count.venueConfigsSecondary + account._count.venueConfigsTertiary,
      terminals: terminalCountByMerchant[account.id] || 0,
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

  // Determine if this is a Blumon "pending" account (no credentials but has serial number)
  const isBlumonPendingAccount = provider.code === 'BLUMON' && data.blumonSerialNumber && !data.credentials

  // Validate required credential fields (provider-specific)
  // Blumon pending accounts can skip credentials - they'll be fetched via OAuth later
  if (!isBlumonPendingAccount) {
    if (!data.credentials) {
      throw new BadRequestError('Credentials object is required')
    }
    // For non-Blumon providers, require merchantId and apiKey
    if (provider.code !== 'BLUMON') {
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
