/**
 * Live Demo Routes
 *
 * Public endpoints for demo.dashboard.avoqado.io auto-login functionality
 */

import { Router, Request } from 'express'
import rateLimit from 'express-rate-limit'
import * as liveDemoController from '@/controllers/liveDemo.controller'
import { validateRequest } from '@/middlewares/validation'
import { simFastPaymentBodySchema } from '@/schemas/liveDemo.schema'

const router = Router()

/**
 * Light rate limiter for simulated demo payments (same express-rate-limit
 * pattern as pin-login-rate-limit.middleware.ts). Keyed by the demo session
 * cookie (falls back to IP). The durable guard is the per-session cap of
 * MAX_SIM_PAYMENTS_PER_SESSION enforced in liveDemo.service.
 */
const simPaymentRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 sim payments per minute per session/IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const sessionId = req.cookies?.liveDemoSessionId
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    return `live-demo-sim:${sessionId || ip}`
  },
  message: {
    error: 'Demasiados pagos simulados. Por favor espera un momento.',
  },
})

/**
 * Rate limiter for auto-login: each cookie-less hit creates (and seeds) a
 * full ephemeral venue, so this endpoint must never be hammerable. Keyed by
 * IP — returning visitors send their cookie and reuse the session, so 20/h
 * is far above any legit usage. The durable guard is the global
 * MAX_CONCURRENT_LIVE_DEMOS cap enforced in liveDemo.service.
 */
const autoLoginRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `live-demo-login:${req.ip || req.socket.remoteAddress || 'unknown'}`,
  message: {
    error: 'Demasiados intentos de demo desde esta conexión. Intenta de nuevo más tarde.',
  },
})

/**
 * @swagger
 * /api/v1/live-demo/auto-login:
 *   get:
 *     summary: Auto-login for live demo
 *     description: Creates or retrieves a live demo session and returns auth tokens
 *     tags:
 *       - Live Demo
 *     responses:
 *       200:
 *         description: Live demo session created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 session:
 *                   type: object
 *                   properties:
 *                     sessionId: { type: string }
 *                     expiresAt: { type: string, format: date-time }
 *       500:
 *         description: Server error
 */
router.get('/auto-login', autoLoginRateLimiter, liveDemoController.autoLoginController)

/**
 * @swagger
 * /api/v1/live-demo/status:
 *   get:
 *     summary: Get live demo session status
 *     description: Returns information about the current live demo session
 *     tags:
 *       - Live Demo
 *     responses:
 *       200:
 *         description: Session status retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 active: { type: boolean }
 *                 session:
 *                   type: object
 *                   properties:
 *                     sessionId: { type: string }
 *                     expiresAt: { type: string, format: date-time }
 */
router.get('/status', liveDemoController.getStatusController)

/**
 * @swagger
 * /api/v1/live-demo/extend:
 *   post:
 *     summary: Extend live demo session
 *     description: Updates session activity to prevent expiration
 *     tags:
 *       - Live Demo
 *     responses:
 *       200:
 *         description: Session activity updated
 *       400:
 *         description: No session found
 */
router.post('/extend', liveDemoController.extendSessionController)

/**
 * @swagger
 * /api/v1/live-demo/sim/fast-payment:
 *   post:
 *     summary: Simulate a TPV fast payment in the visitor's live-demo venue
 *     description: |
 *       Avoqado Tour F2 — creates a REAL fast payment (CARD, COMPLETED) in the
 *       session's ephemeral LIVE_DEMO venue so it appears live in Ventas.
 *       Auth is the liveDemoSessionId cookie (no JWT). Hard-refuses venues
 *       whose status is not LIVE_DEMO.
 *     tags:
 *       - Live Demo
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amountCents]
 *             properties:
 *               amountCents: { type: integer, minimum: 1, maximum: 5000000 }
 *               tipCents: { type: integer, minimum: 0, maximum: 1000000 }
 *     responses:
 *       200:
 *         description: Simulated payment created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     paymentId: { type: string }
 *                     amountCents: { type: integer }
 *                     tipCents: { type: integer }
 *       400:
 *         description: Validation error
 *       401:
 *         description: No demo session (missing or expired cookie)
 *       403:
 *         description: Session venue is not a LIVE_DEMO venue
 *       429:
 *         description: Sim payment cap reached for this session
 */
router.post(
  '/sim/fast-payment',
  simPaymentRateLimiter,
  validateRequest(simFastPaymentBodySchema),
  liveDemoController.simFastPaymentController,
)

/**
 * @swagger
 * /api/v1/live-demo/sim/reservation:
 *   post:
 *     summary: Simulate an online reservation in the visitor's live-demo venue
 *     description: |
 *       Avoqado Tour — journey "reserva": creates a REAL confirmed reservation
 *       (channel WEB, guest "Sofía Ramírez", next half-hour slot ≥1h away) in
 *       the session's ephemeral LIVE_DEMO venue so it appears in the
 *       Reservations calendar. Auth is the liveDemoSessionId cookie (no JWT).
 *       Hard-refuses venues whose status is not LIVE_DEMO. No request body.
 *     tags:
 *       - Live Demo
 *     responses:
 *       200:
 *         description: Simulated reservation created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     reservationId: { type: string }
 *                     confirmationCode: { type: string }
 *                     startsAt: { type: string, format: date-time }
 *       401:
 *         description: No demo session (missing or expired cookie)
 *       403:
 *         description: Session venue is not a LIVE_DEMO venue
 *       429:
 *         description: Sim reservation cap reached for this session
 */
router.post('/sim/reservation', simPaymentRateLimiter, liveDemoController.simReservationController)

/**
 * @swagger
 * /api/v1/live-demo/sim/payment-link:
 *   post:
 *     summary: Simulate a payment link + its web payment in the visitor's live-demo venue
 *     description: |
 *       Avoqado Tour — journey "liga": creates a REAL payment link ("Sesión de
 *       fotos", FIXED $350 MXN, 1 pago cobrado) plus its COMPLETED web payment
 *       (source WEB, VISA •4242) in the session's ephemeral LIVE_DEMO venue —
 *       so the journey can show the liga in Ligas de Pago AND the charge in
 *       Transacciones. Auth is the liveDemoSessionId cookie (no JWT).
 *       Hard-refuses venues whose status is not LIVE_DEMO. No request body.
 *     tags:
 *       - Live Demo
 *     responses:
 *       200:
 *         description: Simulated payment link + payment created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     paymentLinkId: { type: string }
 *                     shortCode: { type: string }
 *                     title: { type: string }
 *                     amountCents: { type: integer }
 *                     paymentId: { type: string }
 *       401:
 *         description: No demo session (missing or expired cookie)
 *       403:
 *         description: Session venue is not a LIVE_DEMO venue
 *       429:
 *         description: Sim payment-link cap reached for this session
 */
router.post('/sim/payment-link', simPaymentRateLimiter, liveDemoController.simPaymentLinkController)

export default router
