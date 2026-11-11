import { Router } from 'express'
import { BadRequestError } from '@/errors/AppError'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { validateVenueAccess } from '@/middlewares/validateVenueAccess.middleware'
import { checkPermission } from '@/middlewares/checkPermission.middleware'
import { checkTableOwnership, PAYMENT_OWNERSHIP_OVERRIDES } from '@/middlewares/checkTableOwnership.middleware'
import { validateRequest } from '@/middlewares/validation'
import { giftCardLookupRateLimiters, giftCardPayFailureRateLimiters } from '@/middlewares/gift-card-lookup-rate-limit.middleware'
import * as ctrl from '@/controllers/mobile/giftCard.mobile.controller'
import { lookupSchema, payGiftCardSchema, paymentByKeySchema } from '@/schemas/mobile/giftCard.mobile.schema'
import { aparatoDe } from '@/utils/giftCardRequest'

const router = Router({ mergeParams: true })
router.use(authenticateTokenMiddleware, validateVenueAccess)

router.post('/lookup', validateRequest(lookupSchema), checkPermission('giftCards:read'), ...giftCardLookupRateLimiters, ctrl.lookup)
router.post(
  '/orders/:orderId/pay',
  validateRequest(payGiftCardSchema),
  checkPermission('giftCards:redeem'),
  ...giftCardPayFailureRateLimiters,
  checkTableOwnership('order', PAYMENT_OWNERSHIP_OVERRIDES),
  (req, _res, next) => {
    if (!aparatoDe(req)) throw new BadRequestError('Falta el identificador del aparato (X-Device-Id).', 'GIFT_CARD_DEVICE_ID_REQUIRED')
    next()
  },
  ctrl.payWithBalance,
)
router.get('/payments/:idempotencyKey', validateRequest(paymentByKeySchema), checkPermission('giftCards:redeem'), ctrl.getPaymentByKey)

export default router
