import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { validateRequest } from '@/middlewares/validation'
import { authenticateConsumer } from '@/middlewares/consumerAuth.middleware'
import { checkPublicVenueFeature } from '@/middlewares/checkFeatureAccess.middleware'
import * as authController from '@/controllers/consumer/auth.consumer.controller'
import * as venueController from '@/controllers/consumer/venue.consumer.controller'
import * as reservationController from '@/controllers/consumer/reservation.consumer.controller'
import * as creditController from '@/controllers/consumer/credit.consumer.controller'
import {
  consumerCreateCreditCheckoutSchema,
  consumerCreateReservationSchema,
  consumerFinalizeCreditCheckoutSchema,
  consumerFinalizeReservationDepositCheckoutSchema,
  consumerOAuthSchema,
  consumerReservationDepositCheckoutSchema,
  consumerVenueParamsSchema,
  searchConsumerVenuesSchema,
} from '@/schemas/consumer.schema'

const router = Router()

const authLimit = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false })
const readLimit = rateLimit({ windowMs: 60_000, max: 80, standardHeaders: true, legacyHeaders: false })
const writeLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })

// Plan-tier gate (RESERVATIONS · Pro) — CREATE-NEW-booking surface ONLY, mirroring
// public.routes.ts. Manage-existing flows (my reservations list, deposit payment /
// finalize for an existing reservation, credit balance) stay UNGATED: a consumer who
// already booked must always be able to manage that booking. Customer-facing 403
// wording — it's the venue's plan, not the consumer's, so no plan/upgrade talk.
const requireReservationsPlan = checkPublicVenueFeature(
  'RESERVATIONS',
  'Este negocio no tiene reservaciones en línea disponibles por el momento.',
)

router.post('/auth/oauth', authLimit, validateRequest(consumerOAuthSchema), authController.oauthLogin)
router.get('/me', readLimit, authenticateConsumer, authController.me)

router.get('/venues', readLimit, authenticateConsumer, validateRequest(searchConsumerVenuesSchema), venueController.search)
router.get('/venues/:venueSlug', readLimit, authenticateConsumer, validateRequest(consumerVenueParamsSchema), venueController.detail)
router.post(
  '/venues/:venueSlug/reservations',
  writeLimit,
  authenticateConsumer,
  requireReservationsPlan,
  validateRequest(consumerCreateReservationSchema),
  reservationController.create,
)

router.get('/reservations', readLimit, authenticateConsumer, reservationController.mine)
router.get('/credits', readLimit, authenticateConsumer, creditController.mine)
router.post(
  '/venues/:venueSlug/reservations/:cancelSecret/payment',
  writeLimit,
  authenticateConsumer,
  validateRequest(consumerReservationDepositCheckoutSchema),
  reservationController.createDepositCheckout,
)
router.post(
  '/reservations/deposit/finalize',
  writeLimit,
  authenticateConsumer,
  validateRequest(consumerFinalizeReservationDepositCheckoutSchema),
  reservationController.finalizeDepositCheckout,
)
// Pre-payment to book (create-flow surface) → gated, like the public sibling.
router.post(
  '/venues/:venueSlug/credit-packs/:packId/checkout',
  writeLimit,
  authenticateConsumer,
  requireReservationsPlan,
  validateRequest(consumerCreateCreditCheckoutSchema),
  creditController.createCheckout,
)
router.post(
  '/credits/checkout/finalize',
  writeLimit,
  authenticateConsumer,
  validateRequest(consumerFinalizeCreditCheckoutSchema),
  creditController.finalizeCheckout,
)

export default router
