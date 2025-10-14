import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import crypto from 'crypto'

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
const ENCRYPTION_KEY = process.env.MERCHANT_CREDENTIALS_ENCRYPTION_KEY || 'default-key-change-in-production-32b' // Must be 32 bytes
const ALGORITHM = 'aes-256-cbc'

/**
 * Encrypt credentials object
 * @param credentials Plain credentials object
 * @returns Encrypted credentials object with iv
 */
function encryptCredentials(credentials: any): any {
  try {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv)

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

    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), Buffer.from(encryptedData.iv, 'hex'))

    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return JSON.parse(decrypted)
  } catch (error) {
    logger.error('Failed to decrypt credentials', { error })
    throw new Error('Credential decryption failed')
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
    merchantId: string
    apiKey: string
    customerId?: string
    [key: string]: any // Allow provider-specific fields
  }
  providerConfig?: any
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
        },
      },
    },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
  })

  // Remove encrypted credentials from response for security
  const sanitizedAccounts = accounts.map(account => ({
    ...account,
    credentialsEncrypted: undefined, // Don't expose encrypted data
    hasCredentials: !!(account.credentialsEncrypted as any)?.encrypted,
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

  return {
    ...account,
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

  // Validate required credential fields
  if (!data.credentials.merchantId || !data.credentials.apiKey) {
    throw new BadRequestError('Credentials must include merchantId and apiKey')
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
