/**
 * Live Demo Controller
 *
 * Handles HTTP requests for public demo sessions (demo.dashboard.avoqado.io)
 */

import { Request, Response, NextFunction } from 'express'
import * as liveDemoService from '@/services/liveDemo.service'
import logger from '@/config/logger'
import { v4 as uuidv4 } from 'uuid'

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

    if (!sessionId) {
      sessionId = uuidv4()
      logger.info(`🆕 Generated new live demo session ID: ${sessionId}`)
    } else {
      logger.info(`♻️ Using existing live demo session ID: ${sessionId}`)
    }

    // Get or create live demo session
    const session = await liveDemoService.getOrCreateLiveDemo(sessionId)

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
