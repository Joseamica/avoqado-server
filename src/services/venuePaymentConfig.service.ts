import prisma from '@/utils/prismaClient'
import { getEffectivePaymentConfig, getEffectivePricing } from '@/services/organization-payment-config.service'
import { BadRequestError } from '@/errors/AppError'
import { AFILIACION_EN_VARIOS_SLOTS, mensajeDeSlotsRepetidos } from '@/services/shared/slotsDeAfiliacion'
import { logAction } from '@/services/dashboard/activity-log.service'
import { assertAngelPayLoginsInVenue } from '@/lib/providerDeviceCompatibility'
import {
  cuentasDeLaOrganizacion,
  exigirConfirmacionDePosiciones,
  tomarCandado,
  type CambioDePosicion,
  type ConfirmacionDePosiciones,
} from '@/services/shared/candadoDePosiciones'

interface VenuePaymentConfigCreateInput {
  venueId: string
  primaryAccountId: string
  secondaryAccountId?: string
  tertiaryAccountId?: string
  routingRules?: any
  preferredProcessor?: 'LEGACY' | 'MENTA' | 'CLIP' | 'BANK_DIRECT' | 'AUTO'
  /** Candado de posiciones (tarifa al comercio, paso 1). */
  positionConfirmations?: ConfirmacionDePosiciones
}

interface VenuePaymentConfigUpdateInput {
  primaryAccountId?: string
  secondaryAccountId?: string | null
  tertiaryAccountId?: string | null
  routingRules?: any
  preferredProcessor?: 'LEGACY' | 'MENTA' | 'CLIP' | 'BANK_DIRECT' | 'AUTO'
  positionConfirmations?: ConfirmacionDePosiciones
}

/**
 * Get payment config for a venue (with org-level fallback).
 * `configSource` dice de dónde sale: `'venue'` (propia del negocio) u `'organization'` (heredada de su organización). Sin él,
 * las pantallas editaban la heredada como si fuera del negocio (encargo e12dc4, 13-nov-2026). Campo nuevo y opcional.
 */
export async function getVenuePaymentConfig(venueId: string) {
  const result = await getEffectivePaymentConfig(venueId)
  if (!result) return null
  return { ...result.config, configSource: result.source }
}

/**
 * Create payment config for a venue
 */
export async function createVenuePaymentConfig(data: VenuePaymentConfigCreateInput) {
  // Verify venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: data.venueId },
  })

  if (!venue) {
    throw new Error('Venue not found')
  }

  // Check if config already exists
  const existingConfig = await prisma.venuePaymentConfig.findUnique({
    where: { venueId: data.venueId },
  })

  if (existingConfig) {
    throw new Error('Payment config already exists for this venue')
  }
  // Codex R12-2: una afiliación no puede ocupar dos slots.
  const repetidos = mensajeDeSlotsRepetidos(data)
  if (repetidos) throw new BadRequestError(repetidos, AFILIACION_EN_VARIOS_SLOTS)
  await assertAngelPayLoginsInVenue(data.venueId, [data.primaryAccountId, data.secondaryAccountId, data.tertiaryAccountId])

  // Verify merchant accounts exist and are active
  const primaryAccount = await prisma.merchantAccount.findUnique({
    where: { id: data.primaryAccountId },
  })

  if (!primaryAccount || !primaryAccount.active) {
    throw new Error('Primary account not found or inactive')
  }

  if (data.secondaryAccountId) {
    const secondaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.secondaryAccountId },
    })

    if (!secondaryAccount || !secondaryAccount.active) {
      throw new Error('Secondary account not found or inactive')
    }
  }

  if (data.tertiaryAccountId) {
    const tertiaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.tertiaryAccountId },
    })

    if (!tertiaryAccount || !tertiaryAccount.active) {
      throw new Error('Tertiary account not found or inactive')
    }
  }

  // Create payment config (candado: el negocio deja de heredar las cuentas de su organización)
  let positionChanges: CambioDePosicion[] = []
  const config = await prisma.$transaction(async tx => {
    positionChanges = await exigirConfirmacionDePosiciones(tx, {
      objetivo: { venueId: data.venueId },
      siguiente: {
        PRIMARY: data.primaryAccountId,
        SECONDARY: data.secondaryAccountId ?? null,
        TERTIARY: data.tertiaryAccountId ?? null,
      },
      confirmaciones: data.positionConfirmations,
    })
    return tx.venuePaymentConfig.create({
      data: {
        venueId: data.venueId,
        primaryAccountId: data.primaryAccountId,
        secondaryAccountId: data.secondaryAccountId,
        tertiaryAccountId: data.tertiaryAccountId,
        routingRules: data.routingRules || {},
        preferredProcessor: data.preferredProcessor || 'AUTO',
      },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        primaryAccount: {
          include: {
            provider: true,
          },
        },
        secondaryAccount: {
          include: {
            provider: true,
          },
        },
        tertiaryAccount: {
          include: {
            provider: true,
          },
        },
      },
    })
  })

  logAction({
    venueId: data.venueId,
    action: 'VENUE_PAYMENT_CONFIG_CREATED',
    entity: 'VenuePaymentConfig',
    entityId: config.id,
    data: { primaryAccountId: data.primaryAccountId, preferredProcessor: data.preferredProcessor, positionChanges },
  })

  return Object.assign(config, { positionChanges })
}

/**
 * Update payment config for a venue
 */
export async function updateVenuePaymentConfig(configId: string, data: VenuePaymentConfigUpdateInput) {
  // Verify config exists
  const existingConfig = await prisma.venuePaymentConfig.findUnique({
    where: { id: configId },
  })

  if (!existingConfig) {
    throw new Error('Payment config not found')
  }

  // Verify merchant accounts if provided
  if (data.primaryAccountId) {
    const primaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.primaryAccountId },
    })

    if (!primaryAccount || !primaryAccount.active) {
      throw new Error('Primary account not found or inactive')
    }
  }

  if (data.secondaryAccountId) {
    const secondaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.secondaryAccountId },
    })

    if (!secondaryAccount || !secondaryAccount.active) {
      throw new Error('Secondary account not found or inactive')
    }
  }

  if (data.tertiaryAccountId) {
    const tertiaryAccount = await prisma.merchantAccount.findUnique({
      where: { id: data.tertiaryAccountId },
    })

    if (!tertiaryAccount || !tertiaryAccount.active) {
      throw new Error('Tertiary account not found or inactive')
    }
  }

  // Codex R12-2: sobre la configuración RESULTANTE (edición parcial sobre lo existente).
  const existente = await prisma.venuePaymentConfig.findUnique({
    where: { id: configId },
    select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
  })
  const repetidos = mensajeDeSlotsRepetidos({
    primaryAccountId: data.primaryAccountId ?? existente?.primaryAccountId,
    secondaryAccountId: data.secondaryAccountId === undefined ? existente?.secondaryAccountId : data.secondaryAccountId,
    tertiaryAccountId: data.tertiaryAccountId === undefined ? existente?.tertiaryAccountId : data.tertiaryAccountId,
  })
  if (repetidos) throw new BadRequestError(repetidos, AFILIACION_EN_VARIOS_SLOTS)
  await assertAngelPayLoginsInVenue(existingConfig.venueId, [data.primaryAccountId, data.secondaryAccountId, data.tertiaryAccountId])

  // Update payment config — candado sólo sobre las posiciones que esta escritura toca (`undefined` = no se toca)
  let positionChanges: CambioDePosicion[] = []
  const config = await prisma.$transaction(async tx => {
    positionChanges = await exigirConfirmacionDePosiciones(tx, {
      objetivo: { venueId: existingConfig.venueId },
      siguiente: { PRIMARY: data.primaryAccountId, SECONDARY: data.secondaryAccountId, TERTIARY: data.tertiaryAccountId },
      confirmaciones: data.positionConfirmations,
    })
    return tx.venuePaymentConfig.update({
      where: { id: configId },
      data: {
        primaryAccountId: data.primaryAccountId,
        secondaryAccountId: data.secondaryAccountId,
        tertiaryAccountId: data.tertiaryAccountId,
        routingRules: data.routingRules,
        preferredProcessor: data.preferredProcessor,
      },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        primaryAccount: {
          include: {
            provider: true,
          },
        },
        secondaryAccount: {
          include: {
            provider: true,
          },
        },
        tertiaryAccount: {
          include: {
            provider: true,
          },
        },
      },
    })
  })

  logAction({
    venueId: existingConfig.venueId,
    action: 'VENUE_PAYMENT_CONFIG_UPDATED',
    entity: 'VenuePaymentConfig',
    entityId: configId,
    data: { changes: Object.keys(data).filter(k => k !== 'positionConfirmations'), positionChanges },
  })

  return Object.assign(config, { positionChanges })
}

/**
 * Delete payment config for a venue
 */
export async function deleteVenuePaymentConfig(configId: string, positionConfirmations?: ConfirmacionDePosiciones) {
  // Verify config exists
  const existingConfig = await prisma.venuePaymentConfig.findUnique({
    where: { id: configId },
  })

  if (!existingConfig) {
    throw new Error('Payment config not found')
  }

  // Delete payment config (candado: sin configuración propia el negocio pasa a las cuentas de su organización)
  const positionChanges = await prisma.$transaction(async tx => {
    // Codex p12-r3 #2: los candados ANTES de calcular las cuentas que heredaría (la organización no cambia mientras tanto).
    await tomarCandado(tx, { venueId: existingConfig.venueId })
    const venue = await tx.venue.findUnique({ where: { id: existingConfig.venueId }, select: { organizationId: true } })
    const cambios = await exigirConfirmacionDePosiciones(tx, {
      objetivo: { venueId: existingConfig.venueId },
      siguiente: venue ? await cuentasDeLaOrganizacion(tx, venue.organizationId) : { PRIMARY: null, SECONDARY: null, TERTIARY: null },
      confirmaciones: positionConfirmations,
      siguienteCalculado: true,
    })
    await tx.venuePaymentConfig.delete({ where: { id: configId } })
    return cambios
  })

  logAction({
    venueId: existingConfig.venueId,
    action: 'VENUE_PAYMENT_CONFIG_DELETED',
    entity: 'VenuePaymentConfig',
    entityId: configId,
    data: { positionChanges },
  })

  return { success: true }
}

/**
 * Get merchant accounts for a venue (with org-level fallback)
 */
export async function getVenueMerchantAccounts(venueId: string) {
  const result = await getEffectivePaymentConfig(venueId)
  const config = result?.config

  if (!config) {
    return []
  }

  const accounts: any[] = []

  if (config.primaryAccount) {
    accounts.push({
      ...config.primaryAccount,
      accountType: 'PRIMARY',
    })
  }

  if (config.secondaryAccount) {
    accounts.push({
      ...config.secondaryAccount,
      accountType: 'SECONDARY',
    })
  }

  if (config.tertiaryAccount) {
    accounts.push({
      ...config.tertiaryAccount,
      accountType: 'TERTIARY',
    })
  }

  return accounts
}

/**
 * Get venue pricing structures for a venue (with org-level fallback)
 */
export async function getVenuePricingByVenue(venueId: string) {
  const result = await getEffectivePricing(venueId)
  return result?.pricing ?? []
}

/**
 * Get active cost structures for venue's merchant accounts
 */
export async function getVenueCostStructures(venueId: string) {
  const accounts = await getVenueMerchantAccounts(venueId)

  const costStructures = []

  for (const account of accounts) {
    if (account.costStructures && account.costStructures.length > 0) {
      costStructures.push({
        ...account.costStructures[0],
        accountType: account.accountType,
        merchantAccount: {
          id: account.id,
          displayName: account.displayName,
          alias: account.alias,
        },
      })
    }
  }

  return costStructures
}
