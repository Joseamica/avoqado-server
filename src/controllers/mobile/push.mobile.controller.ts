/**
 * Mobile Push Notification Controller
 *
 * Handles device token registration and management for push notifications.
 */

import { Request, Response, NextFunction } from 'express'
import * as pushService from '../../services/mobile/push.mobile.service'
import { DevicePlatform } from '@prisma/client'
import { z } from 'zod'
import prisma from '../../utils/prismaClient'

// Validation schemas
const registerDeviceSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  platform: z.nativeEnum(DevicePlatform),
  deviceModel: z.string().optional(),
  osVersion: z.string().optional(),
  appVersion: z.string().optional(),
  bundleId: z.string().optional(),
})

const unregisterDeviceSchema = z.object({
  token: z.string().min(1, 'Token is required'),
})

/**
 * Register a device token for push notifications
 * POST /api/v1/mobile/devices/register
 */
export async function registerDevice(req: Request, res: Response, next: NextFunction) {
  try {
    const staffId = req.authContext?.userId

    if (!staffId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
      })
    }

    // Verify staff exists before registering device token
    const staff = await prisma.staff.findUnique({
      where: { id: staffId },
      select: { id: true },
    })

    if (!staff) {
      return res.status(404).json({
        success: false,
        error: 'Staff not found',
        message: 'Your account no longer exists. Please contact support.',
      })
    }

    const validation = registerDeviceSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const { token, platform, deviceModel, osVersion, appVersion, bundleId } = validation.data

    const deviceToken = await pushService.registerDeviceToken({
      staffId,
      token,
      platform,
      deviceModel,
      osVersion,
      appVersion,
      bundleId,
    })

    return res.status(200).json({
      success: true,
      message: 'Device registered successfully',
      device: {
        id: deviceToken.id,
        platform: deviceToken.platform,
        active: deviceToken.active,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Unregister a device token (e.g., on logout)
 * POST /api/v1/mobile/devices/unregister
 */
export async function unregisterDevice(req: Request, res: Response, next: NextFunction) {
  try {
    const validation = unregisterDeviceSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const { token } = validation.data
    const success = await pushService.unregisterDeviceToken(token)

    return res.status(200).json({
      success: true,
      message: success ? 'Device unregistered successfully' : 'Device not found',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get current user's registered devices
 * GET /api/v1/mobile/devices
 */
export async function getMyDevices(req: Request, res: Response, next: NextFunction) {
  try {
    const staffId = req.authContext?.userId

    if (!staffId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
      })
    }

    const devices = await pushService.getStaffDeviceTokens(staffId)

    return res.status(200).json({
      success: true,
      devices: devices.map(d => ({
        id: d.id,
        platform: d.platform,
        deviceModel: d.deviceModel,
        appVersion: d.appVersion,
        active: d.active,
        lastUsed: d.lastUsed,
      })),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Send a test push notification to the current user
 * POST /api/v1/mobile/push/test
 */
export async function sendTestPush(req: Request, res: Response, next: NextFunction) {
  try {
    const staffId = req.authContext?.userId

    if (!staffId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
      })
    }

    const { title, body } = req.body

    const result = await pushService.sendPushToStaff(staffId, {
      title: title || 'Prueba de Avoqado',
      body: body || 'Las notificaciones push funcionan correctamente!',
      data: {
        type: 'TEST',
        timestamp: new Date().toISOString(),
      },
    })

    return res.status(200).json({
      success: result.success,
      message: result.success ? `Notificación enviada a ${result.successCount} dispositivo(s)` : 'No se pudo enviar la notificación',
      details: {
        successCount: result.successCount,
        failureCount: result.failureCount,
      },
    })
  } catch (error) {
    next(error)
  }
}
