import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AuthContext, AvoqadoJwtPayload, buildAuthContextFromPayload } from '../security'
import { IMPERSONATION_ERROR_CODES } from '../types/impersonation'
import * as liveDemoService from '../services/liveDemo.service'
import { isJtiRevoked } from '../utils/tokenRevocation'
import { enforceImpersonationRules } from './impersonationGuard.middleware'

export const authenticateTokenMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // BUSCAR EN COOKIES PRIMERO (Dashboard Web)
    let token = req.cookies?.accessToken

    // Si no hay cookie, buscar en Authorization header (TPV/API)
    if (!token) {
      const authHeader = req.headers['authorization']
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7)
      }
    }

    if (!token) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'No authentication token provided',
      })
      return
    }

    // SECURITY: Explicitly specify algorithm to prevent algorithm substitution attacks
    // Without this, an attacker could use 'none' algorithm or switch to RS256
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!, {
      algorithms: ['HS256'],
    }) as AvoqadoJwtPayload

    // SECURITY: Check JTI revocation list (defense-in-depth for impersonation stop/extend).
    // This enforces that old impersonation tokens can't be replayed after a /stop or /extend.
    if (decoded.jti && (await isJtiRevoked(decoded.jti))) {
      res.clearCookie('accessToken')
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Token has been revoked',
      })
      return
    }

    // IMPERSONATION: defense-in-depth expiresAt check.
    // The JWT's own `exp` is also set to `act.expiresAt` (see generateImpersonationAccessToken),
    // so jwt.verify would have thrown TokenExpiredError. This is a belt-and-suspenders check
    // in case the JWT was issued with a longer `exp` for any reason.
    if (decoded.act) {
      const nowSeconds = Math.floor(Date.now() / 1000)
      if (decoded.act.expiresAt <= nowSeconds) {
        res.clearCookie('accessToken')
        res.status(401).json({
          error: 'Unauthorized',
          code: IMPERSONATION_ERROR_CODES.EXPIRED,
          message: 'La sesión de impersonación ha expirado.',
        })
        return
      }
    }

    // Construir el contexto con semántica de impersonación (RFC 8693 act claim).
    const authContext: AuthContext = buildAuthContextFromPayload(decoded)

    req.authContext = authContext

    // Enforce impersonation rules (read-only, blocked routes, target validity).
    // This runs on every authenticated request, so new endpoints are protected by default.
    if (authContext.isImpersonating) {
      const guard = await enforceImpersonationRules(req)
      if (!guard.ok) {
        if (guard.clearCookie) res.clearCookie('accessToken')
        res.status(guard.status).json({
          error: guard.status === 401 ? 'Unauthorized' : 'Forbidden',
          code: guard.code,
          message: guard.message,
        })
        return
      }
    }

    // Track activity for live demo sessions
    const liveDemoSessionId = req.cookies?.liveDemoSessionId
    if (liveDemoSessionId) {
      // Non-blocking activity update (fire and forget)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      liveDemoService.updateLiveDemoActivity(liveDemoSessionId).catch(err => {
        // Silently fail - don't block the request
      })
    }

    next()
  } catch (error) {
    // Limpiar cookie si existe
    if (req.cookies?.accessToken) {
      res.clearCookie('accessToken')
    }

    let message = 'Invalid or expired token'
    let code: string | undefined

    if (error instanceof jwt.TokenExpiredError) {
      message = 'Token has expired'
      // If it was an impersonation token, tag the error so frontend can clean up gracefully.
      // We cannot decode a truly-tampered token, but expired tokens can still be decoded (just not verified).
      try {
        const decoded = jwt.decode(req.cookies?.accessToken) as AvoqadoJwtPayload | null
        if (decoded?.act) {
          code = IMPERSONATION_ERROR_CODES.EXPIRED
          message = 'La sesión de impersonación ha expirado.'
        }
      } catch {
        // ignore — fall back to generic expired message
      }
    } else if (error instanceof jwt.JsonWebTokenError) {
      message = 'Invalid token'
    }

    res.status(401).json({
      error: 'Unauthorized',
      ...(code && { code }),
      message,
    })
  }
}
