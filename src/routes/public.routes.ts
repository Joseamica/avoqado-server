import { Router } from 'express'
import { z } from 'zod'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { getPublicReceipt } from '../controllers/public/receipt.public.controller'
import {
  autofacturaController,
  getAutofacturaStatusController,
  sendCfdiWhatsAppController,
  downloadCfdiZipController,
} from '../controllers/public/cfdi.public.controller'
import { submitReviewFromReceipt, checkReviewStatus, getReviewForReceipt } from '../controllers/public/receiptReview.public.controller'
import * as reservationPublicController from '../controllers/public/reservation.public.controller'
import * as creditPackPublicController from '../controllers/public/creditPack.public.controller'
import * as customerPortalController from '../controllers/public/customerPortal.public.controller'
import * as otpAuthController from '../controllers/public/otpAuth.public.controller'
import * as paymentLinkPublicController from '../controllers/public/paymentLink.public.controller'
import * as venueCheckoutController from '../controllers/public/venueCheckout.public.controller'
import { submitContact, submitLabsBrief } from '../controllers/public/landing.public.controller'
import * as venueChatController from '../controllers/public/venueChat.public.controller'
import * as tpvOrderPublicController from '../controllers/public/tpvOrder.public.controller'
import { assignSerialsPublicSchema, rejectSpeiSchema } from '../schemas/public/tpvOrder.public.schema'
import { validateRequest } from '../middlewares/validation'
import { authenticateCustomer } from '../middlewares/customerAuth.middleware'
import { checkPublicVenueFeature } from '../middlewares/checkFeatureAccess.middleware'
import { venueChatAuth } from '../middlewares/venueChatAuth.middleware'
import {
  createSessionBodySchema,
  pollMessagesQuerySchema,
  postMessageBodySchema,
  resumeSessionBodySchema,
  sessionParamsSchema,
} from '../schemas/public/venueChat.schema'
import {
  publicVenueParamsSchema,
  publicReservationParamsSchema,
  publicCreateReservationBodySchema,
  publicCreateHoldBodySchema,
  publicHoldParamsSchema,
  getAvailabilityQuerySchema,
  cancelBodySchema,
  publicRescheduleBodySchema,
  rescheduleAvailabilityQuerySchema,
  rescheduleHoldBodySchema,
} from '../schemas/dashboard/reservation.schema'
import {
  publicPacksParamsSchema,
  publicBalanceQuerySchema,
  publicCheckoutSchema,
  customerRegisterSchema,
  customerLoginSchema,
  customerUpdateProfileSchema,
  otpRequestSchema,
  otpVerifySchema,
} from '../schemas/dashboard/creditPack.schema'
import { autofacturaSchema } from '../schemas/dashboard/cfdi.schema'
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
import {
  venueCheckoutInfoSchema,
  venueStripeIntentSchema,
  venueMpIntentSchema,
  venueMpPaySchema,
  venueCheckoutSessionSchema,
} from '../schemas/public/venueCheckout.schema'

const router = Router()

// Wildcard CORS for public endpoints — no credentials needed, safe for embedding
router.use(cors({ origin: '*', credentials: false, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }))

// Rate limiting: read endpoints (60 req/min), write (5 req/min), cancel (10 req/min)
const readLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
const writeLimit = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false })
const cancelLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })
const authLimit = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false })
// CFDI stamping costs money — tight per-IP cap to prevent abuse
const cfdiLimit = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false })
// Second limiter keyed on the receipt accessKey: no single ticket can be hammered regardless of IP.
// Mitigates wallet-drain + slot-denial velocity (e.g. a customer double-tapping the autofactura button).
const cfdiPerKeyLimit = rateLimit({
  windowMs: 60_000,
  max: 3,
  keyGenerator: req => (req.params as any).accessKey ?? req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
})

// Digital Receipt routes
router.get('/receipt/:accessKey', getPublicReceipt)

// CFDI autofactura (Flow A) — customer self-service invoice from receipt page
// Both cfdiLimit (per-IP) and cfdiPerKeyLimit (per-accessKey) must pass to reach the controller.
router.post('/receipt/:accessKey/cfdi', cfdiLimit, cfdiPerKeyLimit, validateRequest(autofacturaSchema), autofacturaController)
router.get('/receipt/:accessKey/cfdi', readLimit, getAutofacturaStatusController)
// Send the stamped factura to a WhatsApp number (rate-limited like the stamp itself).
router.post('/receipt/:accessKey/cfdi/whatsapp', cfdiLimit, cfdiPerKeyLimit, sendCfdiWhatsAppController)
// Download a single .zip with the factura's PDF + XML.
router.get('/receipt/:accessKey/cfdi/download', readLimit, downloadCfdiZipController)

// Receipt Review routes
router.post('/receipt/:accessKey/review', submitReviewFromReceipt)
router.get('/receipt/:accessKey/review/status', checkReviewStatus)
router.get('/receipt/:accessKey/review', getReviewForReceipt)

// ---- Public Reservation / Booking Routes (unauthenticated) ----

// Plan-tier gate (RESERVATIONS · Pro) — CREATE-NEW-booking surface ONLY.
// GOLDEN RULE: never gate manage-existing flows (magic-link :cancelSecret
// cancel/reschedule, customer portal/login/OTP, balance reads) — a customer who
// already booked must always be able to manage that booking, regardless of the
// venue's current plan. The 403 wording is CUSTOMER-facing: it's the venue's
// plan, not the customer's, so it never mentions plans or upgrades.
const requireReservationsPlan = checkPublicVenueFeature(
  'RESERVATIONS',
  'Este negocio no tiene reservaciones en línea disponibles por el momento.',
)

router.get(
  '/venues/:venueSlug/info',
  readLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema })),
  reservationPublicController.getVenueInfo,
)

router.get(
  '/venues/:venueSlug/availability',
  readLimit,
  requireReservationsPlan,
  validateRequest(z.object({ params: publicVenueParamsSchema, query: getAvailabilityQuerySchema })),
  reservationPublicController.getAvailability,
)

router.post(
  '/venues/:venueSlug/reservations',
  writeLimit,
  requireReservationsPlan,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: publicCreateReservationBodySchema })),
  reservationPublicController.createReservation,
)

// Slot hold (Square "Cita reservada durante 9:56" countdown). The widget
// creates a hold when the customer reaches the payment step and consumes it
// (deletion) on successful reservation. The cancel route lets the widget
// release a hold if the customer navigates back. Both hold routes are part of
// the CREATE flow, so the pair is gated consistently with the create POST.
router.post(
  '/venues/:venueSlug/reservations/hold',
  writeLimit,
  requireReservationsPlan,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: publicCreateHoldBodySchema })),
  reservationPublicController.createHold,
)
router.delete(
  '/venues/:venueSlug/reservations/hold/:holdId',
  cancelLimit,
  requireReservationsPlan,
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

// Appointment reschedule sub-flow (scoped by cancelSecret; self-exclusion server-side).
// Registered before the bare /reschedule POST is irrelevant (distinct path segments),
// but kept together for readability.
router.get(
  '/venues/:venueSlug/reservations/:cancelSecret/reschedule/availability',
  readLimit,
  validateRequest(z.object({ params: publicReservationParamsSchema, query: rescheduleAvailabilityQuerySchema })),
  reservationPublicController.getRescheduleAvailability,
)
router.post(
  '/venues/:venueSlug/reservations/:cancelSecret/reschedule/hold',
  writeLimit,
  validateRequest(z.object({ params: publicReservationParamsSchema, body: rescheduleHoldBodySchema })),
  reservationPublicController.createRescheduleHold,
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

// Checkout is a PRE-PAYMENT to book (create-flow surface) → gated. The pack
// LIST + BALANCE reads above stay UNGATED: existing credit holders must always
// be able to see what they already paid for, regardless of the venue's plan.
router.post(
  '/venues/:venueSlug/credit-packs/:packId/checkout',
  writeLimit,
  requireReservationsPlan,
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

// ---- Passwordless OTP login (WhatsApp / email) ----

router.post(
  '/venues/:venueSlug/auth/otp/request',
  writeLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: otpRequestSchema })),
  otpAuthController.requestOtp,
)
router.post(
  '/venues/:venueSlug/auth/otp/verify',
  authLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: otpVerifySchema })),
  otpAuthController.verifyOtp,
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

// Mercado Pago Bricks (inline) flow — customer stays on pay.avoqado.io and pays
// via embedded MP Brick (analog of Stripe Elements). Returns publicKey +
// sessionId so the frontend SDK can initialize and tokenize the card in-iframe.
router.post('/payment-links/:shortCode/mp-payment-intent', writeLimit, paymentLinkPublicController.createMercadoPagoPaymentIntent)

// Brick onSubmit callback — receives the tokenized card from the Brick frontend
// and creates the MP payment with application_fee on the seller's account.
router.post('/payment-links/:shortCode/mp-pay', writeLimit, paymentLinkPublicController.executeMercadoPagoPayment)

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

// ---- Public Venue Checkout Routes (unauthenticated) ----
// Powers the embeddable checkout widget. Charges go directly to a venue's
// connected processor with a host/customer-provided amount — no payment link.

router.get('/venues/:venueSlug/checkout-info', readLimit, validateRequest(venueCheckoutInfoSchema), venueCheckoutController.getCheckoutInfo)

router.post(
  '/venues/:venueSlug/checkout/payment-intent',
  writeLimit,
  validateRequest(venueStripeIntentSchema),
  venueCheckoutController.createStripePaymentIntent,
)

router.post(
  '/venues/:venueSlug/checkout/mp-payment-intent',
  writeLimit,
  validateRequest(venueMpIntentSchema),
  venueCheckoutController.createMercadoPagoPaymentIntent,
)

router.post(
  '/venues/:venueSlug/checkout/mp-pay',
  writeLimit,
  validateRequest(venueMpPaySchema),
  venueCheckoutController.executeMercadoPagoPayment,
)

router.get(
  '/venues/:venueSlug/checkout/session/:sessionId',
  readLimit,
  validateRequest(venueCheckoutSessionSchema),
  venueCheckoutController.getSessionStatus,
)

// ---- Landing Page Routes (unauthenticated) — called from avoqado.io frontend ----
// nodemailer doesn't work on Cloudflare Pages Functions, so the landing proxies
// email submissions to this server which uses Resend (HTTP).
router.post('/contact', writeLimit, submitContact)
router.post('/labs/submit', writeLimit, submitLabsBrief)

// ---- Venue Chat (customer ↔ venue messaging via WABA relay) ----
//
// Customer-facing endpoints. POST /sessions is the only one without
// venueChatAuth — it mints the accessToken returned to the widget. All
// others require Bearer <accessToken>.
//
// Rate limits: writeLimit (5/min IP) for session creation is intentional —
// real customers create at most one session per visit. Per-session limits
// for poll (60/min) and post (30/min) are tighter than venueChatPollLimit
// below so a single abusive session can't DoS the dispatcher.

const venueChatPollLimit = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false })
const venueChatPostLimit = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })

router.post(
  '/venue-chat/sessions',
  writeLimit,
  validateRequest(z.object({ body: createSessionBodySchema })),
  venueChatController.postSession,
)

router.get(
  '/venue-chat/sessions/:id',
  readLimit,
  validateRequest(z.object({ params: sessionParamsSchema })),
  venueChatAuth,
  venueChatController.getSession,
)

router.get(
  '/venue-chat/sessions/:id/messages',
  venueChatPollLimit,
  validateRequest(z.object({ params: sessionParamsSchema, query: pollMessagesQuerySchema })),
  venueChatAuth,
  venueChatController.getMessages,
)

router.post(
  '/venue-chat/sessions/:id/messages',
  venueChatPostLimit,
  validateRequest(z.object({ params: sessionParamsSchema, body: postMessageBodySchema })),
  venueChatAuth,
  venueChatController.postMessage,
)

// Email-link resume: no Bearer auth (whole point is to mint one). writeLimit
// caps brute-force on email-vs-sessionId combinations to 5/min/IP.
router.post(
  '/venue-chat/sessions/:id/resume',
  writeLimit,
  validateRequest(z.object({ params: sessionParamsSchema, body: resumeSessionBodySchema })),
  venueChatController.postResume,
)

// ---- Public TerminalOrder SPEI Magic-Link Routes (Plan 2 · Task 9) ----
// Token-based, no session/Bearer auth. The signed JWT in `?token=...` proves
// authorization and is verified inside each controller. Rate-limited like the
// other mutating public endpoints.
router.get('/tpv-orders/:id/approve', cancelLimit, tpvOrderPublicController.approveOrderHandler)
router.get('/tpv-orders/:id/approve/check', readLimit, tpvOrderPublicController.approveCheckHandler)
router.post('/tpv-orders/:id/reject', cancelLimit, validateRequest(rejectSpeiSchema), tpvOrderPublicController.rejectOrderHandler)

// ---- Public TerminalOrder Serial-Assignment Magic-Link Routes (Plan 3 · Task 4) ----
// Same token-based pattern as approve/reject: the signed JWT in `?token=...`
// (action: 'assign-serials') proves authorization. POST clears the token on
// success so the magic link is single-use.
router.get('/tpv-orders/:id/assign-serials/check', readLimit, tpvOrderPublicController.assignSerialsCheckHandler)
router.post(
  '/tpv-orders/:id/assign-serials',
  cancelLimit,
  validateRequest(assignSerialsPublicSchema),
  tpvOrderPublicController.assignSerialsPublicHandler,
)

export default router
