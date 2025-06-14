import { handlePosOrderTest } from '@/controllers/pos-sync/posSync.controller'
import { Router } from 'express'

const router = Router()

/**
 * @openapi
 * /pos-sync/test/pos-order:
 *   post:
 *     tags:
 *       - POS Sync Tests
 *     summary: Simulate a POS order for testing
 *     description: >
 *       This endpoint is for development and testing purposes only.
 *       It simulates receiving an order from a POS system via RabbitMQ,
 *       allowing to test the `posSync.service` logic directly.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PosOrderPayload'
 *     responses:
 *       '200':
 *         description: Order processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Test order processed successfully
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       '400':
 *         description: Invalid payload
 *       '500':
 *         description: Internal server error
 */
router.post('/test/pos-order', handlePosOrderTest)

export default router
