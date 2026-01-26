/**
 * Mobile Routes
 *
 * API endpoints for mobile apps (iOS, Android).
 * Base path: /api/v1/mobile
 */

import { Router } from 'express'
import * as authMobileController from '../controllers/mobile/auth.mobile.controller'

const router = Router()

// ============================================================================
// PASSKEY (WebAuthn) AUTHENTICATION
// Public endpoints - no authentication required
// ============================================================================

/**
 * @openapi
 * /api/v1/mobile/auth/passkey/challenge:
 *   post:
 *     tags: [Mobile - Authentication]
 *     summary: Generate passkey authentication challenge
 *     description: |
 *       First step in passkey sign-in flow.
 *       Returns a challenge that must be signed by the user's passkey (Face ID, Touch ID, etc).
 *
 *       **Flow:**
 *       1. Mobile app calls this endpoint to get a challenge
 *       2. App presents the passkey authentication UI to the user
 *       3. User authenticates with biometrics
 *       4. App sends the signed assertion to /passkey/verify
 *     responses:
 *       200:
 *         description: Challenge generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 challenge:
 *                   type: string
 *                   description: Base64URL encoded challenge to be signed
 *                 challengeKey:
 *                   type: string
 *                   description: Key to identify this challenge during verification (send back with /verify)
 *                 rpId:
 *                   type: string
 *                   description: Relying Party ID
 *                   example: avoqado.io
 *                 timeout:
 *                   type: number
 *                   description: Challenge validity in milliseconds
 *                   example: 300000
 *                 userVerification:
 *                   type: string
 *                   description: User verification requirement
 *                   example: preferred
 *       500:
 *         description: Server error
 */
router.post('/auth/passkey/challenge', authMobileController.passkeyChallenge)

/**
 * @openapi
 * /api/v1/mobile/auth/passkey/verify:
 *   post:
 *     tags: [Mobile - Authentication]
 *     summary: Verify passkey assertion and authenticate
 *     description: |
 *       Second step in passkey sign-in flow.
 *       Verifies the signed assertion from the authenticator and returns auth tokens.
 *
 *       **iOS Implementation:**
 *       Use ASAuthorizationController with ASAuthorizationPlatformPublicKeyCredentialProvider
 *       to get the credential assertion, then send it to this endpoint.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - credential
 *             properties:
 *               credential:
 *                 type: object
 *                 description: WebAuthn credential assertion from the authenticator
 *                 required:
 *                   - id
 *                   - response
 *                 properties:
 *                   id:
 *                     type: string
 *                     description: Base64URL encoded credential ID
 *                   rawId:
 *                     type: string
 *                     description: Base64URL encoded raw credential ID (same as id)
 *                   type:
 *                     type: string
 *                     default: public-key
 *                   response:
 *                     type: object
 *                     required:
 *                       - authenticatorData
 *                       - clientDataJSON
 *                       - signature
 *                       - userHandle
 *                     properties:
 *                       authenticatorData:
 *                         type: string
 *                         description: Base64URL encoded authenticator data
 *                       clientDataJSON:
 *                         type: string
 *                         description: Base64URL encoded client data JSON
 *                       signature:
 *                         type: string
 *                         description: Base64URL encoded signature
 *                       userHandle:
 *                         type: string
 *                         description: Base64URL encoded user handle (user ID)
 *               challengeKey:
 *                 type: string
 *                 description: The challengeKey returned from /passkey/challenge
 *               rememberMe:
 *                 type: boolean
 *                 default: false
 *                 description: Whether to extend token expiration (30 days vs 24 hours)
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Login exitoso
 *                 user:
 *                   type: object
 *                   description: Authenticated user data
 *                   properties:
 *                     id:
 *                       type: string
 *                     email:
 *                       type: string
 *                     firstName:
 *                       type: string
 *                     lastName:
 *                       type: string
 *                     venues:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           name:
 *                             type: string
 *                           slug:
 *                             type: string
 *                           role:
 *                             type: string
 *                 accessToken:
 *                   type: string
 *                   description: JWT access token (store in Keychain)
 *                 refreshToken:
 *                   type: string
 *                   description: JWT refresh token (store in Keychain)
 *       400:
 *         description: Invalid credential format
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Credential requerido
 *       401:
 *         description: Authentication failed (invalid passkey, expired challenge, etc)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: Passkey no registrado. Por favor usa otro método de autenticación.
 */
router.post('/auth/passkey/verify', authMobileController.passkeyVerify)

export default router
