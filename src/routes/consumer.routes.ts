import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { validateRequest } from '@/middlewares/validation'
import { authenticateConsumer } from '@/middlewares/consumerAuth.middleware'
import * as authController from '@/controllers/consumer/auth.consumer.controller'
import * as venueController from '@/controllers/consumer/venue.consumer.controller'
import * as reservationController from '@/controllers/consumer/reservation.consumer.controller'
import {
  consumerCreateReservationSchema,
  consumerOAuthSchema,
  consumerVenueParamsSchema,
  searchConsumerVenuesSchema,
} from '@/schemas/consumer.schema'

const router = Router()

const authLimit = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false })
const readLimit = rateLimit({ windowMs: 60_000, max: 80, standardHeaders: true, legacyHeaders: false })
const writeLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })

router.post('/auth/oauth', authLimit, validateRequest(consumerOAuthSchema), authController.oauthLogin)
router.get('/me', readLimit, authenticateConsumer, authController.me)

router.get('/venues', readLimit, authenticateConsumer, validateRequest(searchConsumerVenuesSchema), venueController.search)
router.get('/venues/:venueSlug', readLimit, authenticateConsumer, validateRequest(consumerVenueParamsSchema), venueController.detail)
router.post(
  '/venues/:venueSlug/reservations',
  writeLimit,
  authenticateConsumer,
  validateRequest(consumerCreateReservationSchema),
  reservationController.create,
)

router.get('/reservations', readLimit, authenticateConsumer, reservationController.mine)

export default router
