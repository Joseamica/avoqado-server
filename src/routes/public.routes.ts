import { Router } from 'express'
import { z } from 'zod'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { getPublicReceipt } from '../controllers/public/receipt.public.controller'
import { submitReviewFromReceipt, checkReviewStatus, getReviewForReceipt } from '../controllers/public/receiptReview.public.controller'
import * as reservationPublicController from '../controllers/public/reservation.public.controller'
import * as creditPackPublicController from '../controllers/public/creditPack.public.controller'
import * as customerPortalController from '../controllers/public/customerPortal.public.controller'
import * as paymentLinkPublicController from '../controllers/public/paymentLink.public.controller'
import { submitContact, submitLabsBrief } from '../controllers/public/landing.public.controller'
import { validateRequest } from '../middlewares/validation'
import { authenticateCustomer } from '../middlewares/customerAuth.middleware'
import {
  publicVenueParamsSchema,
  publicReservationParamsSchema,
  publicCreateReservationBodySchema,
  publicCreateHoldBodySchema,
  publicHoldParamsSchema,
  getAvailabilityQuerySchema,
  cancelBodySchema,
  publicRescheduleBodySchema,
} from '../schemas/dashboard/reservation.schema'
import {
  publicPacksParamsSchema,
  publicBalanceQuerySchema,
  publicCheckoutSchema,
  customerRegisterSchema,
  customerLoginSchema,
  customerUpdateProfileSchema,
} from '../schemas/dashboard/creditPack.schema'
import {
  publicShortCodeSchema,
  publicCheckoutSchema as plCheckoutSchema,
  publicChargeSchema,
  publicSessionSchema,
  publicStripeCheckoutSchema,
  publicStripePaymentIntentSchema,
  publicSendReceiptWhatsappSchema,
  publicSendReceiptEmailSchema,
} from '../schemas/dashboard/paymentLink.schema'

const router = Router()

// Wildcard CORS for public endpoints — no credentials needed, safe for embedding
router.use(cors({ origin: '*', credentials: false, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] }))

// Rate limiting: read endpoints (60 req/min), write (5 req/min), cancel (10 req/min)
const readLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
const writeLimit = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false })
const cancelLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })
const authLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })

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

// Slot hold (Square "Cita reservada durante 9:56" countdown). The widget
// creates a hold when the customer reaches the payment step and consumes it
// (deletion) on successful reservation. The cancel route lets the widget
// release a hold if the customer navigates back.
router.post(
  '/venues/:venueSlug/reservations/hold',
  writeLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: publicCreateHoldBodySchema })),
  reservationPublicController.createHold,
)
router.delete(
  '/venues/:venueSlug/reservations/hold/:holdId',
  cancelLimit,
  validateRequest(z.object({ params: publicHoldParamsSchema })),
  reservationPublicController.cancelHold,
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

router.post(
  '/venues/:venueSlug/reservations/:cancelSecret/reschedule',
  cancelLimit, // same rate envelope — destructive-ish public mutation
  validateRequest(z.object({ params: publicReservationParamsSchema, body: publicRescheduleBodySchema })),
  reservationPublicController.rescheduleReservation,
)

// ---- Public Credit Pack / Bundle Routes (unauthenticated) ----

router.get(
  '/venues/:venueSlug/credit-packs',
  readLimit,
  validateRequest(publicPacksParamsSchema),
  creditPackPublicController.getAvailablePacks,
)

router.get(
  '/venues/:venueSlug/credit-packs/balance',
  readLimit,
  validateRequest(publicBalanceQuerySchema),
  creditPackPublicController.getCustomerBalance,
)

router.post(
  '/venues/:venueSlug/credit-packs/:packId/checkout',
  writeLimit,
  validateRequest(publicCheckoutSchema),
  creditPackPublicController.createCheckout,
)

// ---- Customer Portal (authenticated) ----

router.post('/venues/:venueSlug/customer/register', authLimit, validateRequest(customerRegisterSchema), customerPortalController.register)

router.post('/venues/:venueSlug/customer/login', authLimit, validateRequest(customerLoginSchema), customerPortalController.login)

router.get('/venues/:venueSlug/customer/portal', readLimit, authenticateCustomer, customerPortalController.getPortal)

router.patch(
  '/venues/:venueSlug/customer/profile',
  writeLimit,
  authenticateCustomer,
  validateRequest(customerUpdateProfileSchema),
  customerPortalController.updateProfile,
)

// ---- Public Payment Link Routes (unauthenticated) ----

router.get('/payment-links/:shortCode', readLimit, validateRequest(publicShortCodeSchema), paymentLinkPublicController.resolvePaymentLink)

router.post('/payment-links/:shortCode/checkout', writeLimit, validateRequest(plCheckoutSchema), paymentLinkPublicController.createCheckout)

// Stripe Connect hosted-checkout flow. Returns a redirect URL the public
// checkout site sends the customer to — application_fee_amount (Avoqado's
// margin) is automatically applied based on the merchant's platformFeeBps.
router.post(
  '/payment-links/:shortCode/stripe-checkout',
  writeLimit,
  validateRequest(publicStripeCheckoutSchema),
  paymentLinkPublicController.createStripeCheckout,
)

// Stripe Elements (inline) flow — customer stays on pay.avoqado.io and pays
// via embedded Stripe Elements. Returns clientSecret to confirm on the frontend.
router.post(
  '/payment-links/:shortCode/payment-intent',
  writeLimit,
  validateRequest(publicStripePaymentIntentSchema),
  paymentLinkPublicController.createStripePaymentIntent,
)

router.post('/payment-links/:shortCode/charge', writeLimit, validateRequest(publicChargeSchema), paymentLinkPublicController.completeCharge)

router.get(
  '/payment-links/:shortCode/session/:sessionId',
  readLimit,
  validateRequest(publicSessionSchema),
  paymentLinkPublicController.getSessionStatus,
)

router.post(
  '/payment-links/:shortCode/send-receipt-whatsapp',
  writeLimit,
  validateRequest(publicSendReceiptWhatsappSchema),
  paymentLinkPublicController.sendReceiptWhatsapp,
)

router.post(
  '/payment-links/:shortCode/send-receipt-email',
  writeLimit,
  validateRequest(publicSendReceiptEmailSchema),
  paymentLinkPublicController.sendReceiptEmail,
)

// ---- Landing Page Routes (unauthenticated) — called from avoqado.io frontend ----
// nodemailer doesn't work on Cloudflare Pages Functions, so the landing proxies
// email submissions to this server which uses Resend (HTTP).
router.post('/contact', writeLimit, submitContact)
router.post('/labs/submit', writeLimit, submitLabsBrief)

export default router
