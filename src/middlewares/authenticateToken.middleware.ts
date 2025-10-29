import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AuthContext } from '../security'
import * as liveDemoService from '../services/liveDemo.service'

export const authenticateTokenMiddleware = (req: Request, res: Response, next: NextFunction): void => {
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

    // Verificar token
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as any

    // Crear contexto de autenticación
    const authContext: AuthContext = {
      userId: decoded.sub,
      orgId: decoded.orgId,
      venueId: decoded.venueId,
      role: decoded.role,
    }

    req.authContext = authContext

    // Track activity for live demo sessions
    const liveDemoSessionId = req.cookies?.liveDemoSessionId
    if (liveDemoSessionId) {
      // Non-blocking activity update (fire and forget)
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
    if (error instanceof jwt.TokenExpiredError) {
      message = 'Token has expired'
    } else if (error instanceof jwt.JsonWebTokenError) {
      message = 'Invalid token'
    }

    res.status(401).json({
      error: 'Unauthorized',
      message,
    })
  }
}
