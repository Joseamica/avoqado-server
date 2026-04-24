/**
 * Crypto Config Dashboard Service
 *
 * Manages per-venue B4Bit device configuration.
 * Each venue gets its own B4Bit device (deviceId + secretKey).
 *
 * Flow (100% login-less, per https://docs.b4bit.com/pay/api/autenticacion/):
 * 1. Superadmin enables crypto for a venue → creates PENDING_SETUP record
 * 2. Superadmin creates device in B4Bit dashboard manually and copies Device ID + Secret Key
 * 3. Superadmin pastes both values in Avoqado dashboard → validated via GET /currencies with
 *    only X-Device-Id header (no login, no Authorization header) → ACTIVE
 * 4. Payments use venue-specific deviceId + secretKey (see b4bit.service.ts)
 */

import { CryptoConfigStatus } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, InternalServerError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'

// B4Bit API base URL by environment. No loginUrl — auth is X-Device-Id header only.
const isProduction = process.env.NODE_ENV === 'production'
const B4BIT_BASE_URL = isProduction ? 'https://pos.b4bit.com' : 'https://dev-payments.b4bit.com'

function getB4BitGlobalConfig() {
  return { baseUrl: B4BIT_BASE_URL }
}

/**
 * Enable crypto payments for a venue (creates PENDING_SETUP record)
 * The device must be created manually in the B4Bit dashboard.
 */
export async function enableCryptoForVenue(venueId: string) {
  const existing = await prisma.venueCryptoConfig.findUnique({ where: { venueId } })
  if (existing) {
    if (existing.status === CryptoConfigStatus.INACTIVE) {
      const updated = await prisma.venueCryptoConfig.update({
        where: { venueId },
        data: { status: existing.b4bitSecretKey ? CryptoConfigStatus.ACTIVE : CryptoConfigStatus.PENDING_SETUP },
      })

      logAction({
        venueId,
        action: 'CRYPTO_ENABLED',
        entity: 'VenueCryptoConfig',
        entityId: updated.id,
      })

      return sanitizeConfig(updated)
    }
    throw new BadRequestError('Crypto ya está configurado para este venue')
  }

  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { name: true },
  })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const deviceName = `Avoqado - ${venue.name}`

  // Create DB record in PENDING_SETUP — no B4Bit API call
  // Superadmin must create the device in B4Bit dashboard and enter credentials here
  const cryptoConfig = await prisma.venueCryptoConfig.create({
    data: {
      venueId,
      b4bitDeviceId: '', // Will be filled in setup step
      b4bitDeviceName: deviceName,
      status: CryptoConfigStatus.PENDING_SETUP,
    },
  })

  logger.info('✅ Crypto config created (PENDING_SETUP)', { venueId, deviceName })

  logAction({
    venueId,
    action: 'CRYPTO_ENABLED',
    entity: 'VenueCryptoConfig',
    entityId: cryptoConfig.id,
  })

  return sanitizeConfig(cryptoConfig)
}

/**
 * Complete crypto setup by saving Device ID + Secret Key, then validating
 */
export async function completeCryptoSetup(venueId: string, deviceId: string, secretKey: string) {
  const existing = await prisma.venueCryptoConfig.findUnique({ where: { venueId } })
  if (!existing) throw new NotFoundError('Crypto no está habilitado para este venue')
  if (existing.status === CryptoConfigStatus.INACTIVE) {
    throw new BadRequestError('Crypto está desactivado. Reactívalo primero.')
  }

  // Validate credentials by making a test API call with the device ID.
  // Per B4Bit docs (https://docs.b4bit.com/pay/api/autenticacion/), X-Device-Id
  // is the ONLY header needed — no Authorization header, no login.
  const config = getB4BitGlobalConfig()

  try {
    const testResponse = await fetch(`${config.baseUrl}/api/v1/currencies/`, {
      method: 'GET',
      headers: {
        'X-Device-Id': deviceId,
      },
    })

    if (!testResponse.ok) {
      const errorText = await testResponse.text()
      logger.warn('⚠️ B4Bit: Validation call failed', { status: testResponse.status, error: errorText.substring(0, 200) })
      throw new BadRequestError('No se pudo validar el Device ID con B4Bit. Verifica que sea correcto.')
    }

    logger.info('✅ B4Bit: Device ID validated successfully', { venueId, deviceId })
  } catch (error: any) {
    if (error instanceof BadRequestError) throw error
    logger.error('❌ B4Bit: Validation error', { error: error.message })
    throw new InternalServerError('Error al validar configuración con B4Bit')
  }

  // Save credentials and activate
  const updated = await prisma.venueCryptoConfig.update({
    where: { venueId },
    data: {
      b4bitDeviceId: deviceId,
      b4bitSecretKey: secretKey,
      status: CryptoConfigStatus.ACTIVE,
    },
  })

  logger.info('✅ Crypto config activated for venue', { venueId })

  logAction({
    venueId,
    action: 'CRYPTO_SETUP_COMPLETED',
    entity: 'VenueCryptoConfig',
    entityId: updated.id,
  })

  return sanitizeConfig(updated)
}

/**
 * Get crypto config for a venue (without exposing full secretKey)
 */
export async function getCryptoConfig(venueId: string) {
  const config = await prisma.venueCryptoConfig.findUnique({ where: { venueId } })
  if (!config) return null
  return sanitizeConfig(config)
}

/**
 * Disable crypto for a venue
 */
export async function disableCrypto(venueId: string) {
  const existing = await prisma.venueCryptoConfig.findUnique({ where: { venueId } })
  if (!existing) throw new NotFoundError('Crypto no está habilitado para este venue')

  const updated = await prisma.venueCryptoConfig.update({
    where: { venueId },
    data: { status: CryptoConfigStatus.INACTIVE },
  })

  logger.info('🚫 Crypto disabled for venue', { venueId })

  logAction({
    venueId,
    action: 'CRYPTO_DISABLED',
    entity: 'VenueCryptoConfig',
    entityId: updated.id,
  })

  return sanitizeConfig(updated)
}

export function getWebhookUrl(): string {
  const apiBaseUrl = process.env.API_BASE_URL || 'https://api.avoqado.io'
  return `${apiBaseUrl}/api/v1/webhooks/b4bit`
}

export function getB4BitDashboardUrl(): string {
  // Superadmin-facing UI link to the B4Bit admin dashboard where devices and secrets are managed.
  return isProduction ? 'https://pay.b4bit.com' : 'https://dev-pay.b4bit.com'
}

function sanitizeConfig(config: {
  id: string
  venueId: string
  b4bitDeviceId: string
  b4bitDeviceName: string
  b4bitSecretKey: string | null
  status: CryptoConfigStatus
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: config.id,
    venueId: config.venueId,
    b4bitDeviceId: config.b4bitDeviceId,
    b4bitDeviceName: config.b4bitDeviceName,
    hasSecretKey: !!config.b4bitSecretKey,
    b4bitSecretKeyMasked: config.b4bitSecretKey ? `****${config.b4bitSecretKey.slice(-4)}` : null,
    status: config.status,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  }
}
