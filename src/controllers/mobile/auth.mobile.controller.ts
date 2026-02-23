/**
 * Mobile Auth Controller
 *
 * Authentication endpoints for mobile apps (iOS, Android).
 * Handles:
 * - Email/password login (tokens in response body)
 * - Token refresh
 * - Passkey (WebAuthn) authentication for passwordless login
 */

import { NextFunction, Request, Response } from 'express'
import logger from '../../config/logger'
import * as authMobileService from '../../services/mobile/auth.mobile.service'
import { requestPasswordReset } from '../../services/dashboard/auth.service'

// ============================================================================
// EMAIL/PASSWORD AUTHENTICATION
// ============================================================================

/**
 * Login with email and password
 * PUBLIC endpoint - no authentication required
 * Returns tokens in response body (mobile apps can't read httpOnly cookies)
 *
 * @route POST /api/v1/mobile/auth/login
 */
export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, rememberMe } = req.body

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email y contraseña son requeridos',
      })
    }

    const result = await authMobileService.loginWithEmail(email, password, rememberMe === true)

    // Return tokens in body for mobile apps
    res.status(200).json({
      success: true,
      message: 'Login exitoso',
      user: result.staff,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    })
  } catch (error) {
    logger.error('Error in mobile login controller:', error)
    next(error)
  }
}

/**
 * Refresh access token
 * PUBLIC endpoint - no authentication required
 * Accepts refresh token in request body
 *
 * @route POST /api/v1/mobile/auth/refresh
 */
export const refresh = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token requerido',
      })
    }

    const result = await authMobileService.refreshAccessToken(refreshToken)

    res.status(200).json({
      success: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    })
  } catch (error) {
    logger.error('Error in mobile refresh controller:', error)
    next(error)
  }
}

// ============================================================================
// PASSKEY (WebAuthn) AUTHENTICATION
// ============================================================================

/**
 * Generate passkey challenge
 * PUBLIC endpoint - no authentication required
 * First step in the passkey sign-in flow
 *
 * @route POST /api/v1/mobile/auth/passkey/challenge
 */
export const passkeyChallenge = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authMobileService.generatePasskeyChallenge()

    res.status(200).json({
      success: true,
      challenge: result.challenge,
      challengeKey: result.challengeKey,
      rpId: result.rpId,
      timeout: result.timeout,
      userVerification: result.userVerification,
    })
  } catch (error) {
    logger.error('Error in passkeyChallenge controller:', error)
    next(error)
  }
}

/**
 * Verify passkey assertion and authenticate user
 * PUBLIC endpoint - no authentication required
 * Second step in the passkey sign-in flow
 *
 * @route POST /api/v1/mobile/auth/passkey/verify
 */
export const passkeyVerify = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { credential, challengeKey, rememberMe } = req.body

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: 'Credential requerido',
      })
    }

    // Transform client credential format to server format
    // iOS sends: { id, rawId, type, response: { authenticatorData, clientDataJSON, signature, userHandle } }
    const authCredential = {
      id: credential.id,
      rawId: credential.rawId || credential.id,
      type: credential.type || 'public-key',
      response: {
        authenticatorData: credential.response.authenticatorData,
        clientDataJSON: credential.response.clientDataJSON,
        signature: credential.response.signature,
        userHandle: credential.response.userHandle,
      },
      clientExtensionResults: credential.clientExtensionResults || {},
      authenticatorAttachment: credential.authenticatorAttachment,
    }

    const result = await authMobileService.verifyPasskeyAssertion(authCredential, challengeKey, rememberMe === true)

    // Set cookies (for web clients that might use these endpoints)
    const accessTokenMaxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
    const refreshTokenMaxAge = rememberMe ? 90 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000

    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: accessTokenMaxAge,
      path: '/',
    })

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: refreshTokenMaxAge,
      path: '/',
    })

    // Return response (tokens in body for mobile apps that can't read httpOnly cookies)
    res.status(200).json({
      success: true,
      message: 'Login exitoso',
      user: result.staff,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    })
  } catch (error) {
    logger.error('Error in passkeyVerify controller:', error)
    next(error)
  }
}

// ============================================================================
// PASSWORD RESET
// ============================================================================

/**
 * Request password reset email
 * PUBLIC endpoint - no authentication required
 * Sends a reset link to the user's email (if account exists)
 *
 * @route POST /api/v1/mobile/auth/request-reset
 */
export const requestReset = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email es requerido',
      })
    }

    const result = await requestPasswordReset({ email })

    // Always return success (security: don't reveal if email exists)
    res.status(200).json({
      success: true,
      message: result.message,
    })
  } catch (error) {
    logger.error('Error in mobile requestReset controller:', error)
    // Security: don't reveal internal errors
    res.status(200).json({
      success: true,
      message: 'Si existe una cuenta con este email, recibirás un enlace de restablecimiento.',
    })
  }
}
