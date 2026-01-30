/**
 * Crypto Config Dashboard Controller
 *
 * Manages per-venue B4Bit crypto payment device configuration.
 * Permission: venue-crypto:manage (ADMIN+)
 */

import { Request, Response } from 'express'
import logger from '../../config/logger'
import {
  enableCryptoForVenue,
  completeCryptoSetup,
  getCryptoConfig,
  disableCrypto,
  getWebhookUrl,
  getB4BitDashboardUrl,
  listB4BitDevices,
} from '../../services/dashboard/cryptoConfig.dashboard.service'

/**
 * POST /dashboard/venues/:venueId/crypto/enable
 * Create B4Bit device for venue
 */
export async function enableCrypto(req: Request, res: Response): Promise<void> {
  const { venueId } = req.params

  try {
    const config = await enableCryptoForVenue(venueId)

    res.status(201).json({
      success: true,
      data: {
        ...config,
        webhookUrl: getWebhookUrl(),
        b4bitDashboardUrl: getB4BitDashboardUrl(),
      },
    })
  } catch (error: any) {
    logger.error('❌ Failed to enable crypto', { venueId, error: error.message })
    const status = error.statusCode || 500
    res.status(status).json({ success: false, message: error.message })
  }
}

/**
 * PUT /dashboard/venues/:venueId/crypto/setup
 * Complete setup with Secret Key
 */
export async function setupCrypto(req: Request, res: Response): Promise<void> {
  const { venueId } = req.params
  const { deviceId, secretKey } = req.body

  if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    res.status(400).json({ success: false, message: 'Device ID es requerido' })
    return
  }
  if (!secretKey || typeof secretKey !== 'string' || secretKey.trim().length === 0) {
    res.status(400).json({ success: false, message: 'Secret Key es requerido' })
    return
  }

  try {
    const config = await completeCryptoSetup(venueId, deviceId.trim(), secretKey.trim())

    res.status(200).json({
      success: true,
      data: config,
    })
  } catch (error: any) {
    logger.error('❌ Failed to complete crypto setup', { venueId, error: error.message })
    const status = error.statusCode || 500
    res.status(status).json({ success: false, message: error.message })
  }
}

/**
 * GET /dashboard/venues/:venueId/crypto/config
 * Get current crypto config status
 */
export async function getConfig(req: Request, res: Response): Promise<void> {
  const { venueId } = req.params

  try {
    const config = await getCryptoConfig(venueId)

    res.status(200).json({
      success: true,
      data: config
        ? {
            ...config,
            webhookUrl: getWebhookUrl(),
            b4bitDashboardUrl: getB4BitDashboardUrl(),
          }
        : null,
    })
  } catch (error: any) {
    logger.error('❌ Failed to get crypto config', { venueId, error: error.message })
    res.status(500).json({ success: false, message: error.message })
  }
}

/**
 * PUT /dashboard/venues/:venueId/crypto/disable
 * Disable crypto for venue
 */
export async function disableCryptoHandler(req: Request, res: Response): Promise<void> {
  const { venueId } = req.params

  try {
    const config = await disableCrypto(venueId)

    res.status(200).json({
      success: true,
      data: config,
    })
  } catch (error: any) {
    logger.error('❌ Failed to disable crypto', { venueId, error: error.message })
    const status = error.statusCode || 500
    res.status(status).json({ success: false, message: error.message })
  }
}

/**
 * GET /dashboard/crypto/devices
 * List available B4Bit devices
 */
export async function listDevices(_req: Request, res: Response): Promise<void> {
  try {
    const devices = await listB4BitDevices()
    res.status(200).json({ success: true, data: devices })
  } catch (error: any) {
    logger.error('❌ Failed to list B4Bit devices', { error: error.message })
    res.status(500).json({ success: false, message: error.message })
  }
}
