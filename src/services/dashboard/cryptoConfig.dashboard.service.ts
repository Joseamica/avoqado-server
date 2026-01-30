/**
 * Crypto Config Dashboard Service
 *
 * Manages per-venue B4Bit device configuration.
 * Each venue gets its own B4Bit device (deviceId + secretKey).
 *
 * Flow:
 * 1. Superadmin enables crypto for a venue → creates PENDING_SETUP record
 * 2. Superadmin creates device in B4Bit dashboard manually
 * 3. Superadmin enters Device ID + Secret Key → validated via GET /currencies → ACTIVE
 * 4. Payments use venue-specific deviceId + secretKey
 */

import { CryptoConfigStatus } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, InternalServerError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

// B4Bit URLs by environment (automatic, no env vars needed)
const isProduction = process.env.NODE_ENV === 'production'
const B4BIT_URLS = {
  baseUrl: isProduction ? 'https://pos.b4bit.com' : 'https://dev-payments.b4bit.com',
  loginUrl: isProduction ? 'https://pay.b4bit.com' : 'https://dev-pay.b4bit.com',
}

function getB4BitGlobalConfig() {
  return {
    baseUrl: B4BIT_URLS.baseUrl,
    loginUrl: B4BIT_URLS.loginUrl,
    username: process.env.B4BIT_USERNAME || '',
    password: process.env.B4BIT_PASSWORD || '',
  }
}

// Cached auth data (token + devices from signIn response)
let cachedAuth: {
  token: string
  devices: { device_name: string; device_identifier: string }[]
  expiresAt: number
} | null = null

async function getAuthData() {
  if (cachedAuth && Date.now() < cachedAuth.expiresAt) {
    return cachedAuth
  }

  const config = getB4BitGlobalConfig()
  const response = await fetch(`${config.loginUrl}/api/user/signIn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  })

  const data = await response.json()
  if (data.hasError || !data.result?.token) {
    throw new InternalServerError('B4Bit authentication failed')
  }

  const devices = data.result.merchants?.flatMap((m: any) => m.devices || []) || []

  cachedAuth = {
    token: data.result.token,
    devices,
    expiresAt: Date.now() + 23 * 60 * 60 * 1000,
  }

  return cachedAuth
}

async function getAuthToken(): Promise<string> {
  const auth = await getAuthData()
  return auth.token
}

/**
 * List available B4Bit devices (from signIn response)
 */
export async function listB4BitDevices() {
  const auth = await getAuthData()
  return auth.devices.map((d) => ({
    deviceId: d.device_identifier,
    name: d.device_name,
  }))
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

  // Validate credentials by making a test API call with the device ID
  const config = getB4BitGlobalConfig()
  const authToken = await getAuthToken()

  try {
    const testResponse = await fetch(`${config.baseUrl}/api/v1/currencies/`, {
      method: 'GET',
      headers: {
        Authorization: `Token ${authToken}`,
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
  return sanitizeConfig(updated)
}

export function getWebhookUrl(): string {
  const apiBaseUrl = process.env.API_BASE_URL || 'https://api.avoqado.io'
  return `${apiBaseUrl}/api/v1/webhooks/b4bit`
}

export function getB4BitDashboardUrl(): string {
  return B4BIT_URLS.loginUrl
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
    b4bitSecretKeyMasked: config.b4bitSecretKey
      ? `****${config.b4bitSecretKey.slice(-4)}`
      : null,
    status: config.status,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  }
}
