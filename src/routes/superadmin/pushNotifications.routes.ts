/**
 * Push Notifications Routes (Superadmin)
 *
 * Endpoints for testing and managing push notifications.
 */

import { Router } from 'express'
import * as pushNotificationsController from '../../controllers/superadmin/pushNotifications.superadmin.controller'

const router = Router()

// Get staff with registered devices
router.get('/staff-devices', pushNotificationsController.getStaffWithDevices)

// Send test notification to a specific staff member
router.post('/send-test', pushNotificationsController.sendTestNotification)

// Get push notification statistics
router.get('/stats', pushNotificationsController.getPushStats)

export default router
