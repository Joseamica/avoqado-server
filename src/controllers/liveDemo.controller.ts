/**
 * Live Demo Controller
 *
 * Handles HTTP requests for public demo sessions (demo.dashboard.avoqado.io)
 */

import { Request, Response, NextFunction } from 'express'
import * as liveDemoService from '@/services/liveDemo.service'
import logger from '@/config/logger'
import { v4 as uuidv4 } from 'uuid'
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '@/errors/AppError'

/**
 * Auto-login endpoint for live demo
 * Creates or retrieves a demo session and returns auth tokens
 *
 * GET /api/v1/live-demo/auto-login
 */
export async function autoLoginController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Get or create session ID from cookie
    let sessionId = req.cookies?.liveDemoSessionId
    let isRetry = false

    if (!sessionId) {
      sessionId = uuidv4()
      logger.info(`🆕 Generated new live demo session ID: ${sessionId}`)
    } else {
      logger.info(`♻️ Using existing live demo session ID: ${sessionId}`)
    }

    // Get or create live demo session
    let session
    try {
      session = await liveDemoService.getOrCreateLiveDemo(sessionId)
    } catch (error: any) {
      // If session cleanup failed, generate a new session ID and retry once
      if (error.message === 'EXPIRED_SESSION_CLEANUP_FAILED' && !isRetry) {
        logger.warn(`🔄 Session cleanup failed, generating new session ID`)
        sessionId = uuidv4()
        isRetry = true
        session = await liveDemoService.getOrCreateLiveDemo(sessionId)
      } else {
        throw error
      }
    }

    // Set session cookie (HttpOnly, secure in production)
    res.cookie('liveDemoSessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: 5 * 60 * 60 * 1000, // 5 hours (matches session expiration)
      path: '/',
    })

    // Set auth cookies
    res.cookie('accessToken', session.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes
      path: '/',
    })

    res.cookie('refreshToken', session.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: 5 * 60 * 60 * 1000, // 5 hours
      path: '/',
    })

    logger.info(`✅ Live demo auto-login successful for session ${sessionId}`)

    res.status(200).json({
      success: true,
      message: 'Live demo session created',
      session: {
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
      },
    })
  } catch (error) {
    logger.error('❌ Error in live demo auto-login:', error)
    next(error)
  }
}

/**
 * Get live demo session status
 * Returns info about current live demo session
 *
 * GET /api/v1/live-demo/status
 */
export async function getStatusController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.liveDemoSessionId

    if (!sessionId) {
      res.status(200).json({
        active: false,
        message: 'No live demo session found',
      })
      return
    }

    // Check if session exists
    const session = await liveDemoService.getOrCreateLiveDemo(sessionId)

    res.status(200).json({
      active: true,
      session: {
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
      },
    })
  } catch (error) {
    logger.error('❌ Error getting live demo status:', error)
    next(error)
  }
}

/**
 * Extend live demo session activity
 * Updates lastActivityAt to prevent expiration
 *
 * POST /api/v1/live-demo/extend
 */
export async function extendSessionController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.liveDemoSessionId

    if (!sessionId) {
      res.status(400).json({
        success: false,
        message: 'No live demo session found',
      })
      return
    }

    await liveDemoService.updateLiveDemoActivity(sessionId)

    res.status(200).json({
      success: true,
      message: 'Session activity updated',
    })
  } catch (error) {
    logger.error('❌ Error extending live demo session:', error)
    next(error)
  }
}

/**
 * Simulate a TPV fast payment in the visitor's LIVE_DEMO venue (Avoqado Tour F2)
 * Auth = the liveDemoSessionId cookie (same validation as POST /extend).
 *
 * POST /api/v1/live-demo/sim/fast-payment
 */
export async function simFastPaymentController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.liveDemoSessionId

    if (!sessionId) {
      res.status(401).json({ error: 'No demo session' })
      return
    }

    const { amountCents, tipCents } = req.body as { amountCents: number; tipCents?: number }

    const result = await liveDemoService.simulateFastPayment(sessionId, amountCents, tipCents ?? 0)

    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    // Missing/expired session — same contract as the cookie-less case
    if (error instanceof UnauthorizedError) {
      res.status(401).json({ error: 'No demo session' })
      return
    }

    // Tampered/stale session pointing at a non-LIVE_DEMO venue
    if (error instanceof ForbiddenError) {
      res.status(403).json({ error: error.message })
      return
    }

    // Per-session sim payment cap exceeded
    if (error instanceof TooManyRequestsError) {
      res.status(429).json({ error: error.message })
      return
    }

    logger.error('❌ Error simulating live demo fast payment:', error)
    next(error)
  }
}

/**
 * Simulate an online reservation in the visitor's LIVE_DEMO venue
 * (Avoqado Tour — journey "reserva"). Auth = the liveDemoSessionId cookie.
 *
 * POST /api/v1/live-demo/sim/reservation
 */
export async function simReservationController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.liveDemoSessionId

    if (!sessionId) {
      res.status(401).json({ error: 'No demo session' })
      return
    }

    const result = await liveDemoService.simulateReservation(sessionId)

    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      res.status(401).json({ error: 'No demo session' })
      return
    }
    if (error instanceof ForbiddenError) {
      res.status(403).json({ error: error.message })
      return
    }
    if (error instanceof TooManyRequestsError) {
      res.status(429).json({ error: error.message })
      return
    }

    logger.error('❌ Error simulating live demo reservation:', error)
    next(error)
  }
}

/**
 * Simulate a payment link + its web payment in the visitor's LIVE_DEMO venue
 * (Avoqado Tour — journey "liga"). Auth = the liveDemoSessionId cookie.
 *
 * POST /api/v1/live-demo/sim/payment-link
 */
export async function simPaymentLinkController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.cookies?.liveDemoSessionId

    if (!sessionId) {
      res.status(401).json({ error: 'No demo session' })
      return
    }

    const result = await liveDemoService.simulatePaymentLink(sessionId)

    res.status(200).json({
      success: true,
      data: result,
    })
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      res.status(401).json({ error: 'No demo session' })
      return
    }
    if (error instanceof ForbiddenError) {
      res.status(403).json({ error: error.message })
      return
    }
    if (error instanceof TooManyRequestsError) {
      res.status(429).json({ error: error.message })
      return
    }

    logger.error('❌ Error simulating live demo payment link:', error)
    next(error)
  }
}
