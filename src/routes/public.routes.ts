import express, { Router } from 'express'
import { z } from 'zod'
import cors from 'cors'
import crypto from 'crypto'
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
import * as walletPassController from '../controllers/public/walletPass.public.controller'
import * as walletStampsController from '../controllers/public/walletStamps.public.controller'
import { submitContact, submitLabsBrief, continuarOnboarding } from '../controllers/public/landing.public.controller'
import * as venueChatController from '../controllers/public/venueChat.public.controller'
import * as tpvOrderPublicController from '../controllers/public/tpvOrder.public.controller'
import { getUnsubscribePage, postUnsubscribe } from '../controllers/public/unsubscribe.public.controller'
import * as customerEmailController from '../controllers/public/customerEmail.public.controller'
import { getPublicPrivacyNotice } from '../controllers/public/privacyNotice.public.controller'
import { assignSerialsPublicSchema, rejectSpeiSchema } from '../schemas/public/tpvOrder.public.schema'
import { validateRequest } from '../middlewares/validation'
import { authenticateCustomer, authenticateCustomerOptional } from '../middlewares/customerAuth.middleware'
import { resolveVenueBySlug } from '../middlewares/resolveVenueBySlug.middleware'
import * as kioskCheckInController from '../controllers/kiosk/kioskCheckIn.controller'
import { kioskCheckInCors } from '../middlewares/kioskCheckInCors.middleware'
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

import * as passkitController from '../controllers/public/passkit.public.controller'

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

// Fase 0.B: el venue se resuelve ANTES de la identidad (el slug manda sobre el token), y
// la identidad ANTES del plan (401 de "no eres tú" gana a 403 de "este venue no tiene PRO").
// Cualquier Authorization presente se valida; sin header sigue siendo invitado.
router.post(
  '/venues/:venueSlug/reservations',
  writeLimit,
  resolveVenueBySlug,
  authenticateCustomerOptional,
  requireReservationsPlan,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: publicCreateReservationBodySchema })),
  reservationPublicController.createReservation,
)

// Slot hold (Square "Cita reservada durante 9:56" countdown). Minting belongs
// to the paid create flow; releasing is deliberately ungated so a downgraded
// venue cannot strand capacity until TTL.
// Fase 1: el hold aparta capacidad, así que pasa por el gate de aprobación — y para eso
// necesita identidad. Mismo orden EXACTO que crear reserva, y los tres pasos importan:
// 🔴 `resolveVenueBySlug` va PRIMERO. Sin él, `authenticateCustomer*` no tiene contra qué
// venue validar el token y responde 500 `CUSTOMER_AUTH_INTERNAL` — la ruta se cae para
// TODOS, con o sin sesión. Lo cazó /full-testing con un cliente real; los tests unitarios
// no lo ven porque montan el controlador sin la cadena de middlewares.
// Después la identidad, y al final el plan: el 401 de "no eres tú" gana al 403 de "este
// venue no tiene PRO".
router.post(
  '/venues/:venueSlug/reservations/hold',
  writeLimit,
  resolveVenueBySlug,
  authenticateCustomerOptional,
  requireReservationsPlan,
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

// Appointment reschedule sub-flow (scoped by cancelSecret; self-exclusion server-side).
// Registered before the bare /reschedule POST is irrelevant (distinct path segments),
// but kept together for readability.
router.get(
  '/venues/:venueSlug/reservations/:cancelSecret/reschedule/availability',
  readLimit,
  requireReservationsPlan,
  validateRequest(z.object({ params: publicReservationParamsSchema, query: rescheduleAvailabilityQuerySchema })),
  reservationPublicController.getRescheduleAvailability,
)
router.post(
  '/venues/:venueSlug/reservations/:cancelSecret/reschedule/hold',
  writeLimit,
  requireReservationsPlan,
  validateRequest(z.object({ params: publicReservationParamsSchema, body: rescheduleHoldBodySchema })),
  reservationPublicController.createRescheduleHold,
)
// Fase 0.B: la autorización sigue siendo `cancelSecret`; la identidad opcional va SÓLO para
// rechazar un Authorization presente pero inválido/ajeno (nunca degradar a invitado en silencio).
router.post(
  '/venues/:venueSlug/reservations/:cancelSecret/reschedule',
  cancelLimit, // same rate envelope — destructive-ish public mutation
  resolveVenueBySlug,
  authenticateCustomerOptional,
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

// Fase 0.B: el balance es dato de CUENTA → sesión obligatoria (el slug manda sobre el
// token). Sin plan gate: es lectura manage-existing (regla de oro de arriba).
router.get(
  '/venues/:venueSlug/credit-packs/balance',
  readLimit,
  resolveVenueBySlug,
  authenticateCustomer,
  validateRequest(publicBalanceQuerySchema),
  creditPackPublicController.getCustomerBalance,
)

// Checkout is a PRE-PAYMENT to book (create-flow surface) → gated. The pack
// LIST + BALANCE reads above stay UNGATED: existing credit holders must always
// be able to see what they already paid for, regardless of the venue's plan.
// Fase 0.B: con sesión, la compra se liga al customer del token (el email del body no manda).
// Sin header sigue siendo checkout de invitado.
router.post(
  '/venues/:venueSlug/credit-packs/:packId/checkout',
  writeLimit,
  resolveVenueBySlug,
  authenticateCustomerOptional,
  requireReservationsPlan,
  validateRequest(publicCheckoutSchema),
  creditPackPublicController.createCheckout,
)

// ---- Kiosco: consumir el reto de check-in desde el teléfono del cliente (Fase 5) ----
//
// 🔴 CORS ACOTADO, a diferencia del resto de /public (que es `origin: '*'` para poder
// embeberse en cualquier sitio). Aquí no: este endpoint actúa sobre una sesión de cliente
// autenticada, así que un `*` dejaría a cualquier página ajena dispararlo con la sesión
// de quien la visite. Sólo el widget.
router.post(
  '/venues/:venueSlug/customer/checkin/:challengeId',
  kioskCheckInCors,
  writeLimit,
  resolveVenueBySlug,
  authenticateCustomer,
  kioskCheckInController.consumeChallenge,
)

// ---- Customer Portal (authenticated) ----

router.post('/venues/:venueSlug/customer/register', authLimit, validateRequest(customerRegisterSchema), customerPortalController.register)

router.post('/venues/:venueSlug/customer/login', authLimit, validateRequest(customerLoginSchema), customerPortalController.login)

// Fase 0.B: el slug manda. Antes el portal usaba sólo el venue del JWT e ignoraba la URL.
router.get('/venues/:venueSlug/customer/portal', readLimit, resolveVenueBySlug, authenticateCustomer, customerPortalController.getPortal)

router.patch(
  '/venues/:venueSlug/customer/profile',
  writeLimit,
  resolveVenueBySlug,
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

// ==========================================
// CREDENCIAL DE CLIENTE — Apple Wallet
// ==========================================
// Publica porque el iPhone descarga el .pkpass sin sesion. El aislamiento no lo da
// un token: el controlador exige que el cliente pertenezca a ESE venue.
//
// El codigo LOYALTY_WALLET queda en PRO sin tocar basePlan.service: el gating es
// permitir-por-default, asi que un codigo que NO esta en PREMIUM_ONLY_CODES lo
// obtienen PRO y PREMIUM, y FREE no. Agregarlo a esa lista lo volveria PREMIUM.
//
// El mensaje es para el CLIENTE FINAL: el plan es del negocio, no suyo, asi que
// nunca menciona planes ni mejoras de suscripcion.
const requireWalletPlan = checkPublicVenueFeature('LOYALTY_WALLET', 'Este negocio todavia no tiene tarjeta digital disponible.')

router.get('/venues/:venueSlug/wallet/apple/:customerId', readLimit, requireWalletPlan, walletPassController.downloadApplePass)

// La tarjeta para Android. Mismo candado de plan que la de Apple: el negocio tiene el
// mismo derecho a una u otra, y sería absurdo que el plan cubriera un teléfono y no el otro.
router.get('/venues/:venueSlug/wallet/google/:customerId', readLimit, requireWalletPlan, walletPassController.downloadGooglePass)

// La franja de sellos que Google descarga para pintar la tarjeta. Sin gate de plan: la
// pide un servidor de Google, no una persona, y para llegar aquí ya tuvo que existir un
// pase emitido — que sí pasó por el candado.
router.get('/wallet/stamps/:serialNumber/:revision.png', readLimit, walletStampsController.getStampStrip)

// La marca del negocio y si tiene sellos, para la pagina publica de la tarjeta
// (`book.avoqado.io/<negocio>/tarjeta`, la del cartel del mostrador).
//
// 🔴 Ruta propia y NO `/info`: aquella cierra con 400 cuando el negocio apago las
// reservaciones publicas, y son 69 de 73 los negocios activos que ni siquiera las
// tienen configuradas. Un café con sellos no puede quedar fuera de su propia tarjeta
// por no aceptar citas. Mismo candado de PLAN que la descarga del pase, para que la
// pagina no prometa algo que el ultimo paso va a negar.
router.get('/venues/:venueSlug/stamp-card', readLimit, requireWalletPlan, walletPassController.getStampCardInfo)

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
// El correo se valida con Zod y no a mano: el controller solo comprobaba que el campo
// existiera, asi que un "noesemail" respondia 200 y la confirmacion al prospecto se perdia
// en silencio (nadie se enteraba de que el lead nunca recibio nada).
// Llaves de campana que la landing propaga (mismo listado que `restaurants.astro`).
// Se filtra con allowlist y con tope de largo en vez de aceptar el `record` abierto:
// esto viene de internet SIN autenticar y desde ahora se guarda en la columna JSON
// del ActivityLog del alta, asi que un `utm` sin limite deja escribir basura
// arbitraria en el registro de un lead. Lo que no este aqui se descarta en silencio.
const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
] as const

const utmSchema = z
  .record(z.string(), z.string())
  .optional()
  .transform(u => {
    if (!u) return undefined
    const limpio: Record<string, string> = {}
    for (const k of UTM_KEYS) {
      const v = u[k]
      if (typeof v === 'string' && v.trim()) limpio[k] = v.trim().slice(0, 200)
    }
    return Object.keys(limpio).length > 0 ? limpio : undefined
  })

// El `hutk` es la cookie de HubSpot del visitante y es lo unico que le da
// campana/origen al lead dentro del CRM. Se valida con la misma logica que los
// UTMs — allowlist y descarte SILENCIOSO — y no con un `.regex()` a secas:
// un token malformado tiraria el request entero con 400 y perderiamos el lead
// por un dato de marketing. Formato real: 32 hex.
const hutkSchema = z
  .string()
  .optional()
  .transform(v => (typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v.trim()) ? v.trim() : undefined))

// Mismo criterio: viene de internet sin autenticar y termina como texto en el
// CRM. Solo se acepta una URL http(s) recortada; cualquier otra cosa se tira.
const paginaSchema = z
  .string()
  .optional()
  .transform(v => {
    if (typeof v !== 'string') return undefined
    const s = v.trim().slice(0, 300)
    return /^https?:\/\//i.test(s) ? s : undefined
  })

const contactSchema = z.object({
  body: z.object({
    firstName: z.string().trim().min(1, 'El nombre es requerido'),
    lastName: z.string().trim().min(1, 'El apellido es requerido'),
    phone: z.string().trim().min(1, 'El telefono es requerido'),
    email: z.string().trim().email('Formato de correo invalido'),
    companyName: z.string().trim().min(1, 'El nombre del negocio es requerido'),
    // Calificacion opcional que manda la landing de sector
    employees: z.string().optional(),
    revenue: z.string().optional(),
    businessType: z.string().optional(),
    modules: z.string().optional(),
    source: z.string().optional(),
    utm: utmSchema,
    // Contexto del visitante para el espejo en HubSpot (ver hubspot.client.ts).
    hutk: hutkSchema,
    pageUri: paginaSchema,
    pageName: z.string().trim().max(120).optional(),
  }),
})
router.post('/contact', writeLimit, validateRequest(contactSchema), submitContact)

// Salto medido del magic link del correo de bienvenida: cuenta el clic y redirige
// a la pantalla de contrasena del dashboard. readLimit (no writeLimit) porque un
// usuario puede legitimamente abrir el enlace varias veces desde su correo.
router.get('/onboarding/continuar/:token', readLimit, continuarOnboarding)
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

// ---- Public one-click email unsubscribe (token-based, no auth) ----
// The signed token in `?token=…` (purpose 'unsub') proves authorization and is
// verified inside the controller. GET renders a confirm page (never mutates —
// email clients prefetch links); POST performs the unsubscribe and doubles as
// the RFC 8058 List-Unsubscribe-Post one-click target for Gmail/Yahoo.
const unsubscribePostLimit = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false })
router.get('/unsubscribe', readLimit, getUnsubscribePage)
router.post('/unsubscribe', unsubscribePostLimit, postUnsubscribe)

// ---- Baja one-click y captura de cumpleaños de CLIENTES (token propio, no auth) ----
// La baja usa rate limit POR TOKEN: los one-click de Gmail/Yahoo salen de pocas IPs
// compartidas y un límite por IP los tiraría con 429 (auditoría Codex ronda 1 #22).
const customerUnsubLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req =>
    crypto
      .createHash('sha256')
      .update(String(req.query.token ?? req.ip))
      .digest('hex'),
})
router.get('/customers/unsubscribe', readLimit, customerEmailController.getCustomerUnsubscribePage)
router.post('/customers/unsubscribe', customerUnsubLimit, customerEmailController.postCustomerUnsubscribe)
router.get('/customers/birthdate', readLimit, customerEmailController.getBirthdateCapturePage)
// El GET no necesita parseo de body; el POST viene de un <form> HTML real (no fetch/JSON),
// que el navegador manda como application/x-www-form-urlencoded — sin este parser, escoped
// SOLO a esta ruta, `req.body.birthdate` llegaría undefined (sólo `express.json()` está
// montado a nivel app para /api/v1/public).
router.post(
  '/customers/birthdate',
  customerUnsubLimit,
  express.urlencoded({ extended: true }),
  customerEmailController.postBirthdateCapture,
)

// ---- Aviso de privacidad del NEGOCIO — enlace desde el pie de cada correo (Fase 1C, T7) ----
// Sin auth: cualquiera puede leer un aviso de privacidad, y así lo exige la propia LFPDPPP.
// No lleva token porque no protege nada personal — sólo el texto que el propio negocio ya
// publicó (o, si aún no publicó ninguno, su borrador precargado — Task 8).
router.get('/venues/:venueId/privacy-notice', readLimit, getPublicPrivacyNotice)

// ==========================================
// SERVICIO WEB DE PASSKIT — lo llama APPLE, no nuestro dashboard
// ==========================================
//
// 🔴 Sin autenticación de sesión a propósito: el que llama es el iPhone de un cliente.
// Lo que los protege es el token que viaja dentro del propio pase, verificado en
// tiempo constante dentro del servicio.
//
// Las rutas son las que Apple espera EXACTAMENTE. Un path distinto no da error: Apple
// simplemente nunca llama, y las tarjetas se quedan congeladas sin una sola señal.
router.post(
  '/passkit/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber',
  passkitController.registerDeviceHandler,
)
router.delete(
  '/passkit/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber',
  passkitController.unregisterDeviceHandler,
)
router.get('/passkit/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier', passkitController.listUpdatedSerialsHandler)
router.get('/passkit/v1/passes/:passTypeIdentifier/:serialNumber', passkitController.downloadUpdatedPassHandler)
router.post('/passkit/v1/log', passkitController.passkitLogHandler)

export default router
