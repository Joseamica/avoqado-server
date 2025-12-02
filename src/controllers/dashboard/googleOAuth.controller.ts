import { NextFunction, Request, Response } from 'express'
import * as googleOAuthService from '../../services/dashboard/googleOAuth.service'
import { ValidationError } from '../../errors/AppError'

/**
 * Get Google OAuth authorization URL
 */
export async function getGoogleAuthUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authUrl = googleOAuthService.getGoogleAuthUrl()

    res.status(200).json({
      success: true,
      authUrl,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Handle Google OAuth callback
 */
export async function googleOAuthCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { code, token } = req.body

    if (!code && !token) {
      throw new ValidationError('Either authorization code or ID token is required')
    }

    const result = await googleOAuthService.loginWithGoogle(
      code || token,
      !!code, // isCode = true if code is provided
    )

    // Cookie maxAge must match JWT expiration (24h default for OAuth login)
    const accessTokenMaxAge = 24 * 60 * 60 * 1000 // 24 hours
    const refreshTokenMaxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

    // Set cookies
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

    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Welcome! Account created successfully.' : 'Login successful',
      user: result.staff,
      isNewUser: result.isNewUser,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Handle Google One Tap login
 */
export async function googleOneTapLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { credential } = req.body

    if (!credential) {
      throw new ValidationError('Google One Tap credential is required')
    }

    const result = await googleOAuthService.loginWithGoogleOneTap(credential)

    // Cookie maxAge must match JWT expiration (24h default for OAuth login)
    const accessTokenMaxAge = 24 * 60 * 60 * 1000 // 24 hours
    const refreshTokenMaxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

    // Set cookies
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

    res.status(200).json({
      success: true,
      message: result.isNewUser ? 'Welcome! Account created successfully.' : 'Login successful',
      user: result.staff,
      isNewUser: result.isNewUser,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Check invitation status for an email
 */
export async function checkInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = req.query

    if (!email || typeof email !== 'string') {
      throw new ValidationError('Email is required')
    }

    const invitationStatus = await googleOAuthService.checkInvitationStatus(email)

    res.status(200).json({
      success: true,
      ...invitationStatus,
    })
  } catch (error) {
    next(error)
  }
}
