import express from 'express'
import { validateRequest } from '../middlewares/validation'
import * as invitationController from '../controllers/invitation.controller'
import {
  InvitationTokenParamsSchema,
  AcceptInvitationSchema,
} from '../schemas/invitation.schema'

const router = express.Router()

/**
 * @openapi
 * /api/v1/invitations/{token}:
 *   get:
 *     tags: [Invitations]
 *     summary: Get invitation details by token
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string, format: cuid }
 *     responses:
 *       200:
 *         description: Invitation details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 email: { type: string }
 *                 role: { type: string }
 *                 organizationName: { type: string }
 *                 venueName: { type: string, nullable: true }
 *                 inviterName: { type: string }
 *                 expiresAt: { type: string, format: date-time }
 *                 status: { type: string }
 *       404:
 *         description: Invitation not found or already used
 *       410:
 *         description: Invitation has expired
 */
router.get(
  '/:token',
  validateRequest(InvitationTokenParamsSchema),
  invitationController.getInvitationByToken,
)

/**
 * @openapi
 * /api/v1/invitations/{token}/accept:
 *   post:
 *     tags: [Invitations]
 *     summary: Accept invitation and create user account
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstName
 *               - lastName
 *               - password
 *             properties:
 *               firstName: { type: string, minLength: 1, maxLength: 50 }
 *               lastName: { type: string, minLength: 1, maxLength: 50 }
 *               password: { type: string, minLength: 8 }
 *               pin: { type: string, pattern: '^\\d{4}$', nullable: true }
 *     responses:
 *       200:
 *         description: Invitation accepted and account created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 user: { type: object }
 *                 tokens: { type: object }
 *       400:
 *         description: Validation error
 *       404:
 *         description: Invitation not found or already used
 *       409:
 *         description: User already exists
 *       410:
 *         description: Invitation has expired
 */
router.post(
  '/:token/accept',
  validateRequest(AcceptInvitationSchema),
  invitationController.acceptInvitation,
)

export default router