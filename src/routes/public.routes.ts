import { Router } from 'express'
import { z } from 'zod'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { getPublicReceipt } from '../controllers/public/receipt.public.controller'
import { submitReviewFromReceipt, checkReviewStatus, getReviewForReceipt } from '../controllers/public/receiptReview.public.controller'
import * as reservationPublicController from '../controllers/public/reservation.public.controller'
import { validateRequest } from '../middlewares/validation'
import {
  publicVenueParamsSchema,
  publicReservationParamsSchema,
  publicCreateReservationBodySchema,
  getAvailabilityQuerySchema,
  cancelBodySchema,
} from '../schemas/dashboard/reservation.schema'

const router = Router()

// Wildcard CORS for public endpoints — no credentials needed, safe for embedding
router.use(cors({ origin: '*', credentials: false, methods: ['GET', 'POST', 'OPTIONS'] }))

// Rate limiting: read endpoints (60 req/min), write (5 req/min), cancel (10 req/min)
const readLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
const writeLimit = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false })
const cancelLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })

// Digital Receipt routes
router.get('/receipt/:accessKey', getPublicReceipt)

// Receipt Review routes
router.post('/receipt/:accessKey/review', submitReviewFromReceipt)
router.get('/receipt/:accessKey/review/status', checkReviewStatus)
router.get('/receipt/:accessKey/review', getReviewForReceipt)

// ---- Public Reservation / Booking Routes (unauthenticated) ----

router.get(
  '/venues/:venueSlug/info',
  readLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema })),
  reservationPublicController.getVenueInfo,
)

router.get(
  '/venues/:venueSlug/availability',
  readLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema, query: getAvailabilityQuerySchema })),
  reservationPublicController.getAvailability,
)

router.post(
  '/venues/:venueSlug/reservations',
  writeLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: publicCreateReservationBodySchema })),
  reservationPublicController.createReservation,
)

router.get(
  '/venues/:venueSlug/reservations/:cancelSecret',
  readLimit,
  validateRequest(z.object({ params: publicReservationParamsSchema })),
  reservationPublicController.getReservation,
)

router.post(
  '/venues/:venueSlug/reservations/:cancelSecret/cancel',
  cancelLimit,
  validateRequest(z.object({ params: publicReservationParamsSchema, body: cancelBodySchema })),
  reservationPublicController.cancelReservation,
)

export default router
