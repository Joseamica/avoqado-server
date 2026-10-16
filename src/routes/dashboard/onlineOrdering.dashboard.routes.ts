// Montado en dashboard.routes.ts con `authenticateTokenMiddleware` a nivel router.
import { Router } from 'express'
import { checkFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { validateRequest } from '@/middlewares/validation'
import * as orders from '@/controllers/mobile/onlineOrders.mobile.controller'
import * as admin from '@/controllers/dashboard/onlineOrdering.dashboard.controller'
import {
  acceptSchema,
  inboxSchema,
  menuAvailabilitySchema,
  orderActionSchema,
  rejectSchema,
  settingsGetSchema,
  settingsPatchSchema,
} from '@/schemas/online-ordering.schema'

const router = Router({ mergeParams: true })
// R14: el plan sólo donde se configura la tienda, y siempre DESPUÉS del permiso.
const plan = checkFeatureAccess('ONLINE_ORDERING')

router.get('/settings', validateRequest(settingsGetSchema), checkPermission('online-orders:manage'), admin.getSettingsHandler)
router.put('/settings', validateRequest(settingsPatchSchema), checkPermission('online-orders:manage'), plan, admin.updateSettingsHandler)
router.put(
  '/menu/availability',
  validateRequest(menuAvailabilitySchema),
  checkPermission('online-orders:manage'),
  plan,
  admin.setMenuAvailabilityHandler,
)

// La bandeja del panel comparte manejadores con las apps; late sólo si su página de bandeja manda `x-online-orders-tray: 1`
// (permitida en CORS, H2) y quien mira tiene `orders:update` efectivo (H3).
router.get('/orders', validateRequest(inboxSchema), checkPermission('orders:read'), orders.inbox)
router.post('/orders/:orderId/accept', validateRequest(acceptSchema), checkPermission('orders:update'), orders.accept)
router.post('/orders/:orderId/reject', validateRequest(rejectSchema), checkPermission('orders:update'), orders.reject)
router.post('/orders/:orderId/ready', validateRequest(orderActionSchema), checkPermission('orders:update'), orders.ready)
router.post('/orders/:orderId/delivered', validateRequest(orderActionSchema), checkPermission('orders:update'), orders.delivered)
router.post('/orders/:orderId/cancel', validateRequest(orderActionSchema), checkPermission('orders:cancel-unpaid'), orders.cancel)

export default router
