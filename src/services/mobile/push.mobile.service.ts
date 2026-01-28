/**
 * Mobile Push Notification Service
 *
 * Handles push notifications for mobile apps using Firebase Cloud Messaging (FCM).
 * Supports both iOS (via APNs) and Android devices through FCM.
 *
 * Features:
 * - Device token registration and management
 * - Push notification sending via FCM
 * - Token cleanup for inactive/failed tokens
 * - Batch notification support
 */

import prisma from '../../utils/prismaClient'
import { getFirebaseApp } from '../../config/firebase'
import { DevicePlatform } from '@prisma/client'
import logger from '@/config/logger'
import * as admin from 'firebase-admin'

// ============================================================================
// DEVICE TOKEN MANAGEMENT
// ============================================================================

interface RegisterDeviceParams {
  staffId: string
  token: string
  platform: DevicePlatform
  deviceModel?: string
  osVersion?: string
  appVersion?: string
  bundleId?: string
}

/**
 * Register or update a device token for push notifications
 *
 * @param params - Device registration parameters
 * @returns The created or updated device token
 */
export async function registerDeviceToken(params: RegisterDeviceParams) {
  const { staffId, token, platform, deviceModel, osVersion, appVersion, bundleId } = params

  logger.info(`📱 [Push] Registering device token for staff ${staffId}`)
  logger.info(`   Platform: ${platform}, Model: ${deviceModel || 'unknown'}`)

  // Upsert the device token
  const deviceToken = await prisma.deviceToken.upsert({
    where: { token },
    update: {
      staffId, // Update owner if token is reassigned
      platform,
      deviceModel,
      osVersion,
      appVersion,
      bundleId,
      active: true,
      lastUsed: new Date(),
      failCount: 0, // Reset fail count on re-registration
      updatedAt: new Date(),
    },
    create: {
      staffId,
      token,
      platform,
      deviceModel,
      osVersion,
      appVersion,
      bundleId,
    },
  })

  logger.info(`✅ [Push] Device token registered: ${deviceToken.id}`)
  return deviceToken
}

/**
 * Unregister a device token (e.g., on logout)
 *
 * @param token - The FCM token to unregister
 */
export async function unregisterDeviceToken(token: string) {
  logger.info(`📱 [Push] Unregistering device token`)

  const result = await prisma.deviceToken.updateMany({
    where: { token },
    data: { active: false },
  })

  logger.info(`✅ [Push] Device token unregistered: ${result.count} affected`)
  return result.count > 0
}

/**
 * Get all active device tokens for a staff member
 *
 * @param staffId - The staff member's ID
 * @returns Array of active device tokens
 */
export async function getStaffDeviceTokens(staffId: string) {
  return prisma.deviceToken.findMany({
    where: {
      staffId,
      active: true,
    },
    orderBy: { lastUsed: 'desc' },
  })
}

// ============================================================================
// PUSH NOTIFICATION SENDING
// ============================================================================

interface PushNotificationPayload {
  title: string
  body: string
  data?: Record<string, string>
  imageUrl?: string
  badge?: number
  sound?: string // 'default', 'avoqado_sound.wav', or custom sound filename
}

interface SendPushResult {
  success: boolean
  successCount: number
  failureCount: number
  failedTokens: string[]
}

/**
 * Send push notification to a specific staff member
 *
 * @param staffId - The staff member's ID
 * @param payload - The notification payload
 * @returns Send result with success/failure counts
 */
export async function sendPushToStaff(staffId: string, payload: PushNotificationPayload): Promise<SendPushResult> {
  logger.info(`📤 [Push] Sending push to staff ${staffId}`)
  logger.info(`   Title: ${payload.title}`)

  // Get active tokens for this staff
  const tokens = await getStaffDeviceTokens(staffId)

  if (tokens.length === 0) {
    logger.info(`⚠️ [Push] No active device tokens for staff ${staffId}`)
    return { success: false, successCount: 0, failureCount: 0, failedTokens: [] }
  }

  const tokenStrings = tokens.map(t => t.token)
  return sendPushToTokens(tokenStrings, payload)
}

/**
 * Send push notification to multiple tokens
 *
 * @param tokens - Array of FCM tokens
 * @param payload - The notification payload
 * @returns Send result with success/failure counts
 */
export async function sendPushToTokens(tokens: string[], payload: PushNotificationPayload): Promise<SendPushResult> {
  const firebaseApp = getFirebaseApp()

  if (!firebaseApp) {
    logger.error('❌ [Push] Firebase not initialized')
    return { success: false, successCount: 0, failureCount: tokens.length, failedTokens: tokens }
  }

  if (tokens.length === 0) {
    return { success: true, successCount: 0, failureCount: 0, failedTokens: [] }
  }

  logger.info(`📤 [Push] Sending to ${tokens.length} token(s)`)

  try {
    // Build the FCM message
    const message: admin.messaging.MulticastMessage = {
      tokens,
      notification: {
        title: payload.title,
        body: payload.body,
        imageUrl: payload.imageUrl,
      },
      data: payload.data,
      apns: {
        headers: {
          'apns-priority': '10', // High priority for immediate delivery
        },
        payload: {
          aps: {
            alert: {
              title: payload.title,
              body: payload.body,
            },
            badge: payload.badge ?? 1,
            sound: payload.sound || 'default',
            'mutable-content': 1,
          },
        },
      },
      android: {
        priority: 'high',
        notification: {
          sound: payload.sound || 'default',
          channelId: 'avoqado_notifications',
        },
      },
    }

    // Send via FCM
    const response = await admin.messaging(firebaseApp).sendEachForMulticast(message)

    logger.info(`✅ [Push] Sent: ${response.successCount} success, ${response.failureCount} failed`)

    // Track failed tokens for cleanup
    const failedTokens: string[] = []
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        failedTokens.push(tokens[idx])
        logger.warn(`   ❌ Token ${idx}: ${resp.error?.message}`)

        // Mark token as failed if it's an unregistered/invalid token error
        const errorCode = resp.error?.code
        if (errorCode === 'messaging/registration-token-not-registered' || errorCode === 'messaging/invalid-registration-token') {
          markTokenAsFailed(tokens[idx])
        }
      }
    })

    return {
      success: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
      failedTokens,
    }
  } catch (error) {
    logger.error(`❌ [Push] Error sending notifications:`, error)
    return { success: false, successCount: 0, failureCount: tokens.length, failedTokens: tokens }
  }
}

/**
 * Send push notification to all devices of multiple staff members
 *
 * @param staffIds - Array of staff member IDs
 * @param payload - The notification payload
 * @returns Aggregated send result
 */
export async function sendPushToMultipleStaff(staffIds: string[], payload: PushNotificationPayload): Promise<SendPushResult> {
  logger.info(`📤 [Push] Sending push to ${staffIds.length} staff members`)

  // Get all active tokens for these staff members
  const tokens = await prisma.deviceToken.findMany({
    where: {
      staffId: { in: staffIds },
      active: true,
    },
    select: { token: true },
  })

  const tokenStrings = tokens.map(t => t.token)

  if (tokenStrings.length === 0) {
    logger.info(`⚠️ [Push] No active device tokens for any of the ${staffIds.length} staff members`)
    return { success: false, successCount: 0, failureCount: 0, failedTokens: [] }
  }

  return sendPushToTokens(tokenStrings, payload)
}

// ============================================================================
// TOKEN MAINTENANCE
// ============================================================================

/**
 * Mark a token as failed (increment fail count, deactivate if too many failures)
 */
async function markTokenAsFailed(token: string) {
  const deviceToken = await prisma.deviceToken.findUnique({ where: { token } })

  if (!deviceToken) return

  const newFailCount = deviceToken.failCount + 1
  const shouldDeactivate = newFailCount >= 3 // Deactivate after 3 consecutive failures

  await prisma.deviceToken.update({
    where: { token },
    data: {
      failCount: newFailCount,
      active: shouldDeactivate ? false : deviceToken.active,
    },
  })

  if (shouldDeactivate) {
    logger.info(`🗑️ [Push] Deactivated token after ${newFailCount} failures: ${token.substring(0, 20)}...`)
  }
}

/**
 * Clean up old/inactive tokens (run periodically via cron)
 *
 * @param daysInactive - Deactivate tokens not used in this many days (default: 90)
 * @returns Number of tokens deactivated
 */
export async function cleanupInactiveTokens(daysInactive: number = 90): Promise<number> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysInactive)

  const result = await prisma.deviceToken.updateMany({
    where: {
      active: true,
      lastUsed: { lt: cutoffDate },
    },
    data: { active: false },
  })

  logger.info(`🧹 [Push] Cleaned up ${result.count} inactive tokens (not used in ${daysInactive} days)`)
  return result.count
}

/**
 * Delete deactivated tokens older than specified days
 *
 * @param daysOld - Delete inactive tokens older than this (default: 180)
 * @returns Number of tokens deleted
 */
export async function purgeOldTokens(daysOld: number = 180): Promise<number> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysOld)

  const result = await prisma.deviceToken.deleteMany({
    where: {
      active: false,
      updatedAt: { lt: cutoffDate },
    },
  })

  logger.info(`🗑️ [Push] Purged ${result.count} old inactive tokens`)
  return result.count
}
