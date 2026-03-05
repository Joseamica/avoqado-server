import { NextFunction, Request, Response } from 'express'

/**
 * Enforces JSON requests for mutation endpoints.
 * This reduces CSRF risk from cross-site HTML form submissions.
 */
export const requireJsonBodyMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next()
    return
  }

  const isJson = req.is('application/json') || req.is('application/*+json')

  if (!isJson) {
    res.status(415).json({
      success: false,
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Content-Type must be application/json',
    })
    return
  }

  next()
}
