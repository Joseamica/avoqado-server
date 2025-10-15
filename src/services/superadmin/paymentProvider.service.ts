import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { ProviderType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'

/**
 * PaymentProvider Service
 *
 * Manages the catalog of payment processors that Avoqado integrates with.
 * Examples: MENTA, CLIP, BANORTE_DIRECT, STRIPE, etc.
 *
 * PaymentProviders are the template/metadata layer that describes:
 * - Provider name and code (MENTA, CLIP)
 * - Provider type (PAYMENT_PROCESSOR, BANK_DIRECT, WALLET)
 * - Countries supported (MX, AR, etc.)
 * - Configuration schema for merchant accounts
 */

interface CreatePaymentProviderData {
  code: string // Unique code like "MENTA", "CLIP"
  name: string // Display name like "Menta", "Clip"
  type: ProviderType // PAYMENT_PROCESSOR, BANK_DIRECT, WALLET
  countryCode: string[] // ["MX", "AR"]
  configSchema?: any // Optional JSON schema for validation
  active?: boolean
}

interface UpdatePaymentProviderData {
  name?: string
  type?: ProviderType
  countryCode?: string[]
  configSchema?: any
  active?: boolean
}

/**
 * Get all payment providers
 * @param filters Optional filters for type, country, active status
 * @returns List of payment providers
 */
export async function getPaymentProviders(filters?: { type?: ProviderType; countryCode?: string; active?: boolean }) {
  const where: any = {}

  if (filters?.type) {
    where.type = filters.type
  }

  if (filters?.countryCode) {
    where.countryCode = {
      has: filters.countryCode,
    }
  }

  if (filters?.active !== undefined) {
    where.active = filters.active
  }

  const providers = await prisma.paymentProvider.findMany({
    where,
    include: {
      _count: {
        select: {
          merchants: true,
          costStructures: true,
        },
      },
    },
    orderBy: {
      name: 'asc',
    },
  })

  logger.info('Retrieved payment providers', {
    count: providers.length,
    filters,
  })

  return providers
}

/**
 * Get a single payment provider by ID
 * @param id Provider ID
 * @returns Payment provider with related data
 */
export async function getPaymentProvider(id: string) {
  const provider = await prisma.paymentProvider.findUnique({
    where: { id },
    include: {
      merchants: {
        include: {
          _count: {
            select: {
              costStructures: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      },
      _count: {
        select: {
          merchants: true,
          webhooks: true,
          eventLogs: true,
          costStructures: true,
        },
      },
    },
  })

  if (!provider) {
    throw new NotFoundError(`Payment provider ${id} not found`)
  }

  logger.info('Retrieved payment provider', {
    providerId: id,
    code: provider.code,
    merchantCount: provider._count.merchants,
  })

  return provider
}

/**
 * Get a payment provider by code
 * @param code Provider code (e.g., "MENTA", "CLIP")
 * @returns Payment provider
 */
export async function getPaymentProviderByCode(code: string) {
  const provider = await prisma.paymentProvider.findUnique({
    where: { code: code.toUpperCase() },
    include: {
      merchants: true,
      _count: {
        select: {
          merchants: true,
          costStructures: true,
        },
      },
    },
  })

  if (!provider) {
    throw new NotFoundError(`Payment provider with code ${code} not found`)
  }

  return provider
}

/**
 * Create a new payment provider
 * @param data Provider creation data
 * @returns Created payment provider
 */
export async function createPaymentProvider(data: CreatePaymentProviderData) {
  // Validate code is uppercase and unique
  const code = data.code.toUpperCase()

  const existingProvider = await prisma.paymentProvider.findUnique({
    where: { code },
  })

  if (existingProvider) {
    throw new BadRequestError(`Payment provider with code ${code} already exists`)
  }

  // Validate country codes
  const validCountryCodes = /^[A-Z]{2}$/
  for (const countryCode of data.countryCode) {
    if (!validCountryCodes.test(countryCode)) {
      throw new BadRequestError(`Invalid country code: ${countryCode}. Must be 2-letter ISO code (e.g., MX, AR)`)
    }
  }

  const provider = await prisma.paymentProvider.create({
    data: {
      code,
      name: data.name,
      type: data.type,
      countryCode: data.countryCode,
      configSchema: data.configSchema || null,
      active: data.active !== undefined ? data.active : true,
    },
  })

  logger.info('Payment provider created', {
    providerId: provider.id,
    code: provider.code,
    name: provider.name,
    type: provider.type,
  })

  return provider
}

/**
 * Update a payment provider
 * @param id Provider ID
 * @param data Update data
 * @returns Updated payment provider
 */
export async function updatePaymentProvider(id: string, data: UpdatePaymentProviderData) {
  // Check if provider exists
  const existingProvider = await prisma.paymentProvider.findUnique({
    where: { id },
  })

  if (!existingProvider) {
    throw new NotFoundError(`Payment provider ${id} not found`)
  }

  // Validate country codes if provided
  if (data.countryCode) {
    const validCountryCodes = /^[A-Z]{2}$/
    for (const countryCode of data.countryCode) {
      if (!validCountryCodes.test(countryCode)) {
        throw new BadRequestError(`Invalid country code: ${countryCode}. Must be 2-letter ISO code (e.g., MX, AR)`)
      }
    }
  }

  const provider = await prisma.paymentProvider.update({
    where: { id },
    data: {
      ...(data.name && { name: data.name }),
      ...(data.type && { type: data.type }),
      ...(data.countryCode && { countryCode: data.countryCode }),
      ...(data.configSchema !== undefined && { configSchema: data.configSchema }),
      ...(data.active !== undefined && { active: data.active }),
    },
  })

  logger.info('Payment provider updated', {
    providerId: id,
    code: provider.code,
    updates: Object.keys(data),
  })

  return provider
}

/**
 * Toggle payment provider active status
 * @param id Provider ID
 * @returns Updated payment provider
 */
export async function togglePaymentProviderStatus(id: string) {
  const provider = await prisma.paymentProvider.findUnique({
    where: { id },
  })

  if (!provider) {
    throw new NotFoundError(`Payment provider ${id} not found`)
  }

  const updated = await prisma.paymentProvider.update({
    where: { id },
    data: {
      active: !provider.active,
    },
  })

  logger.info('Payment provider status toggled', {
    providerId: id,
    code: provider.code,
    newStatus: updated.active,
  })

  return updated
}

/**
 * Delete a payment provider (soft delete by setting active=false)
 * Only allowed if no merchant accounts exist
 * @param id Provider ID
 */
export async function deletePaymentProvider(id: string) {
  const provider = await prisma.paymentProvider.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          merchants: true,
        },
      },
    },
  })

  if (!provider) {
    throw new NotFoundError(`Payment provider ${id} not found`)
  }

  // Prevent deletion if merchant accounts exist
  if (provider._count.merchants > 0) {
    throw new BadRequestError(
      `Cannot delete payment provider ${provider.code} because it has ${provider._count.merchants} merchant account(s). Deactivate instead.`,
    )
  }

  // Soft delete by setting active=false
  await prisma.paymentProvider.update({
    where: { id },
    data: {
      active: false,
    },
  })

  logger.warn('Payment provider soft deleted', {
    providerId: id,
    code: provider.code,
  })
}
