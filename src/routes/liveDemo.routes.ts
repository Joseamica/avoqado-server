/**
 * Live Demo Routes
 *
 * Public endpoints for demo.dashboard.avoqado.io auto-login functionality
 */

import { Router } from 'express'
import * as liveDemoController from '@/controllers/liveDemo.controller'

const router = Router()

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

export default router
