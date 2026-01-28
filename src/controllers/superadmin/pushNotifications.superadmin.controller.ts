/**
 * Push Notifications Controller (Superadmin)
 *
 * Handles push notification testing and management for superadmins.
 */

import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import * as pushService from '../../services/mobile/push.mobile.service'
import logger from '@/config/logger'

// Validation schema for sending test notification
const sendTestSchema = z.object({
  staffId: z.string().min(1, 'Staff ID is required'),
  title: z.string().optional(),
  body: z.string().optional(),
})

/**
 * Get all staff members with registered devices
 * GET /api/v1/dashboard/superadmin/push-notifications/staff-devices
 */
export async function getStaffWithDevices(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, search } = req.query

    // Build where clause for devices
    const deviceWhere = {
      active: true,
    }

    // Build where clause for staff
    const staffWhere: {
      deviceTokens: { some: { active: boolean } }
      venues?: { some: { venueId: string } }
      OR?: Array<{
        firstName?: { contains: string; mode: 'insensitive' }
        lastName?: { contains: string; mode: 'insensitive' }
        email?: { contains: string; mode: 'insensitive' }
      }>
    } = {
      deviceTokens: {
        some: deviceWhere,
      },
    }

    // Filter by venue if provided
    if (venueId && typeof venueId === 'string') {
      staffWhere.venues = {
        some: {
          venueId: venueId,
        },
      }
    }

    // Search by name or email
    if (search && typeof search === 'string') {
      staffWhere.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ]
    }

    const staffWithDevices = await prisma.staff.findMany({
      where: staffWhere,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        venues: {
          select: {
            venue: {
              select: {
                id: true,
                name: true,
              },
            },
            role: true,
          },
        },
        deviceTokens: {
          where: { active: true },
          select: {
            id: true,
            platform: true,
            deviceModel: true,
            osVersion: true,
            appVersion: true,
            lastUsed: true,
            createdAt: true,
          },
          orderBy: { lastUsed: 'desc' },
        },
      },
      orderBy: { firstName: 'asc' },
      take: 100,
    })

    // Also get list of venues for the filter dropdown
    const venues = await prisma.venue.findMany({
      select: {
        id: true,
        name: true,
      },
      orderBy: { name: 'asc' },
    })

    return res.status(200).json({
      success: true,
      staff: staffWithDevices.map(s => ({
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        email: s.email,
        venues: s.venues.map(sv => ({
          id: sv.venue.id,
          name: sv.venue.name,
          role: sv.role,
        })),
        devices: s.deviceTokens,
        deviceCount: s.deviceTokens.length,
      })),
      venues,
      total: staffWithDevices.length,
    })
  } catch (error) {
    logger.error('Error fetching staff with devices:', error)
    next(error)
  }
}

/**
 * Send a test push notification to a staff member
 * POST /api/v1/dashboard/superadmin/push-notifications/send-test
 */
export async function sendTestNotification(req: Request, res: Response, next: NextFunction) {
  try {
    const validation = sendTestSchema.safeParse(req.body)

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        details: validation.error.errors,
      })
    }

    const { staffId, title, body } = validation.data

    // Get staff info for logging
    const staff = await prisma.staff.findUnique({
      where: { id: staffId },
      select: { firstName: true, lastName: true, email: true },
    })

    if (!staff) {
      return res.status(404).json({
        success: false,
        error: 'Staff not found',
      })
    }

    logger.info(`📤 [Push Test] Sending to ${staff.firstName} ${staff.lastName} (${staff.email})`)

    const result = await pushService.sendPushToStaff(staffId, {
      title: title || 'Test de Avoqado',
      body: body || `Hola ${staff.firstName}! Las notificaciones push funcionan correctamente.`,
      data: {
        type: 'TEST',
        timestamp: new Date().toISOString(),
        sentBy: 'superadmin',
      },
    })

    logger.info(`📤 [Push Test] Result: ${result.successCount} sent, ${result.failureCount} failed`)

    return res.status(200).json({
      success: result.success,
      message: result.success ? `Notificacion enviada a ${result.successCount} dispositivo(s)` : 'No se pudo enviar la notificacion',
      details: {
        staffName: `${staff.firstName} ${staff.lastName}`,
        successCount: result.successCount,
        failureCount: result.failureCount,
      },
    })
  } catch (error) {
    logger.error('Error sending test notification:', error)
    next(error)
  }
}

/**
 * Get push notification statistics
 * GET /api/v1/dashboard/superadmin/push-notifications/stats
 */
export async function getPushStats(req: Request, res: Response, next: NextFunction) {
  try {
    // Count total devices by platform
    const devicesByPlatform = await prisma.deviceToken.groupBy({
      by: ['platform'],
      _count: { id: true },
      where: { active: true },
    })

    // Count total active devices
    const totalActiveDevices = await prisma.deviceToken.count({
      where: { active: true },
    })

    // Count inactive devices
    const totalInactiveDevices = await prisma.deviceToken.count({
      where: { active: false },
    })

    // Count staff with at least one device
    const staffWithDevices = await prisma.staff.count({
      where: {
        deviceTokens: {
          some: { active: true },
        },
      },
    })

    // Recent registrations (last 7 days)
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const recentRegistrations = await prisma.deviceToken.count({
      where: {
        createdAt: { gte: sevenDaysAgo },
      },
    })

    // Build platform stats object
    const byPlatform: Record<string, number> = {}
    for (const item of devicesByPlatform) {
      byPlatform[item.platform] = item._count.id
    }

    return res.status(200).json({
      success: true,
      stats: {
        totalActiveDevices,
        totalInactiveDevices,
        staffWithDevices,
        recentRegistrations,
        byPlatform,
      },
    })
  } catch (error) {
    logger.error('Error fetching push stats:', error)
    next(error)
  }
}
