import { Router } from 'express'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import * as controller from '@/controllers/hybridBilling.controller'
import rateLimit from 'express-rate-limit'
const router = Router({ mergeParams: true })
const mutationLimit = rateLimit({
  windowMs: 60000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `${req.authContext?.userId}:${req.params.venueId}`,
  message: { success: false, message: 'Hay varias solicitudes en curso. Espera un minuto y retoma el mismo intento.' },
})
router.use((req, res, next) => (req.method === 'GET' ? next() : mutationLimit(req, res, next)))
// Authentication is on the parent mount; permissions resolve the current role in the route venue.
router.get('/purchases/current', checkPermission('billing:subscriptions:read'), controller.currentPurchase)
router.get('/replacement-options', checkPermission('billing:subscriptions:read'), controller.replacementOptions)
router.get('/feature-grid', checkPermission('billing:subscriptions:read'), controller.featureGrid)
router.post('/quotes', checkPermission('billing:subscriptions:manage'), controller.quote)
router.post('/purchases/:id/accept', checkPermission('billing:subscriptions:manage'), controller.accept)
router.get('/purchases/:id', checkPermission('billing:subscriptions:read'), controller.status)
router.post('/purchases/:id/resume', checkPermission('billing:subscriptions:manage'), controller.resume)
router.post('/purchases/:id/cancel', checkPermission('billing:subscriptions:manage'), controller.cancel)
router.get('/contracts', checkPermission('billing:subscriptions:read'), controller.contracts)
router.post('/contracts/:id/selection', checkPermission('billing:subscriptions:manage'), controller.scheduleSelection)
router.post('/contracts/:id/cancel', checkPermission('billing:subscriptions:manage'), controller.cancelContract)
export default router
