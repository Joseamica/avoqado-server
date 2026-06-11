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
router.get('/auto-login', liveDemoController.autoLoginController)

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

export default router
