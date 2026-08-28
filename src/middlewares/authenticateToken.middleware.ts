import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AuthContext, AvoqadoJwtPayload, buildAuthContextFromPayload } from '../security'
import { IMPERSONATION_ERROR_CODES } from '../types/impersonation'
import * as liveDemoService from '../services/liveDemo.service'
import { isJtiRevoked } from '../utils/tokenRevocation'
import { mensajeDeCorte, motivoDeSesionInvalidada } from '../utils/passwordChangeGuard'
import { enforceImpersonationRules } from './impersonationGuard.middleware'
import { enrichContext } from '../observability/executionContext'
import { getVenueName } from '../observability/venueNames'

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

    // SEGURIDAD: el corte de sesion echa a las sesiones que ya estaban abiertas.
    //
    // Sin esto, el dueno que corre a un gerente le cambia la contrasena creyendo
    // que lo dejo fuera, y el gerente sigue entrando desde su celular hasta 90
    // dias (lo que dura el refresh token con "recordarme"). Como los JWT son
    // autonomos, la unica forma de matarlos sin inventar infraestructura es
    // comparar cuando se emitio el token contra la fecha del corte.
    //
    // El corte tiene DOS disparadores —cambio de contrasena y "cerrar sesion en
    // todos mis dispositivos"— y el mensaje dice CUAL fue: ensenarle "tu
    // contrasena cambio" a quien acaba de cerrar sus sesiones lo manda a
    // recuperar una contrasena que nadie toco.
    //
    // Se compara contra `sub` (el Staff dueno del token). En impersonacion eso
    // es el administrador que actua, que es justo a quien hay que echar.
    const motivoDelCorte = await motivoDeSesionInvalidada(decoded.sub, decoded.iat)
    if (motivoDelCorte) {
      res.clearCookie('accessToken')
      res.status(401).json({
        error: 'Unauthorized',
        message: mensajeDeCorte(motivoDelCorte),
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

    // Stamp the tenant onto the execution context that requestLogger opened. From here down
    // every log line — and every error captured later — knows which venue and which user it
    // belongs to, without a single call site passing it along.
    enrichContext({
      venueId: authContext.venueId,
      // The NAME is what makes a log line readable without a database query. Resolved from
      // an in-memory cache: synchronous, and undefined rather than slow when unknown.
      venueName: getVenueName(authContext.venueId),
      userId: authContext.userId,
      role: authContext.role,
      terminalSerial: authContext.terminalSerialNumber,
    })

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
