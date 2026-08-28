import jwt from 'jsonwebtoken'
import { AuthenticatedSocket, SocketAuthenticationError, SocketAuthorizationError, SocketAuthContext } from '../types'
import { AvoqadoJwtPayload } from '../../../security'
import logger from '../../../config/logger'
import { v4 as uuidv4 } from 'uuid'
import prisma from '../../../utils/prismaClient'
import { OPERATIONAL_VENUE_STATUSES } from '../../../lib/venueStatus.constants'
import { isSessionAliveCached } from '../../../services/auth/sessionCache'
import { onWithContext } from '../../../observability/socketContext'

/**
 * Tope de vida de un socket antes de forzar su desconexión (y a que el cliente
 * reconecte), sin importar cuánto le falte al JWT para vencer de verdad.
 *
 * 🔴 [Auditoría, hallazgo Crítico] `setTimeout` recibe el delay como un entero de
 * 32 bits: Node CLAMPA A 1 MS cualquier valor mayor a 2_147_483_647 ms (~24.8 días)
 * — en silencio salvo por un `TimeoutOverflowWarning`, verificado a mano con
 * `node -e`. El token de la PAX dura 30 días EXACTOS
 * (`TPV_ACCESS_TOKEN_EXPIRES_IN_SECONDS`, `security.ts`), y lo mismo el
 * "recuérdame" de dashboard/móvil y los tokens de cliente/consumidor
 * (`jwt.service.ts`, `expiresIn: 2592000`) — los cuatro superan el límite.
 * Encadenar el cierre al `exp` real, sin tope, desconectaba CUALQUIER socket de
 * una terminal PAX a los milisegundos de autenticar, no a los 30 días — la app se
 * veía conectar→desconectar en bucle y el mesero podía cobrar dos veces porque el
 * dashboard nunca se enteraba del primer cobro.
 *
 * La respuesta no es encadenar temporizadores para llegar exacto al `exp` real
 * (correcto, pero sospechoso): es preguntarse si tiene sentido que un socket viva
 * 30 días sin que nadie vuelva a comprobar nada. No lo tiene. Un socket que se
 * desconecta cada 24h y deja que el cliente reconecte es MÁS SANO que uno abierto
 * sin supervisión por un mes — y no es sólo evitar el desborde: cada reconexión
 * vuelve a correr el handshake COMPLETO (`jwt.verify`, `isSessionAliveCached`, el
 * candado de venue operativo), así que una revocación o un venue suspendido que el
 * socket se hubiera perdido en el camino se detecta en la siguiente reconexión —
 * no hasta que el JWT por fin venza, semanas después. `disconnectBySession` sigue
 * siendo el mecanismo EAGER (dispara al momento de revocar); este tope es la red
 * de seguridad de fondo para el resto de la vida del socket.
 */
export const SOCKET_LIFETIME_CAP_MS = 24 * 60 * 60 * 1000 // 24h — bien por debajo del límite de 32 bits (~24.8 días)

/**
 * Socket Authentication Middleware
 * Adapts the existing JWT middleware pattern for Socket.io connections
 * Following the same security.ts and authenticateToken.middleware.ts patterns
 *
 * Security Enhancement (2025-12): Also checks venue operational status
 * to block connections from suspended/closed venues.
 *
 * Sesiones revocables (Parte A, Task 11): antes de esta tarea, el JWT se verificaba UNA
 * sola vez, aquí, y el contexto quedaba estático — una conexión abierta sobrevivía tanto
 * al vencimiento del token como a la revocación de su sesión. Ahora:
 *  - si el token trae `sid`, la sesión debe seguir viva (mismo contrato que
 *    `authenticateTokenMiddleware`, del lado HTTP);
 *  - se programa el cierre del propio socket para cuando venza `exp` — desconectar sólo al
 *    revocar no basta, porque un access token robado podría abrir un socket antes de vencer
 *    y quedarse conectado para siempre.
 * Es async de verdad (ya no una IIFE disparada y olvidada) para que quien la llama —incluida
 * esta prueba— pueda esperar a que el handshake completo (con sus `await` a la caché de
 * sesión y a Prisma) termine antes de mirar el resultado. Ningún llamador existente
 * (`socketManager.setupMiddleware`, `ConnectionController.handleAuthentication`) espera el
 * valor de retorno — los dos dependen sólo de que `next`/el callback se invoque.
 */
export const socketAuthenticationMiddleware = async (socket: AuthenticatedSocket, next: (err?: Error) => void): Promise<void> => {
  const correlationId = uuidv4()
  socket.correlationId = correlationId

  try {
    logger.info('Socket authentication attempt', {
      correlationId,
      socketId: socket.id,
      ip: socket.handshake.address,
      userAgent: socket.handshake.headers['user-agent'],
    })

    // Extract token from different sources (following HTTP middleware pattern)
    let token: string | undefined

    // 1. Check cookies first (Dashboard Web) - matching HTTP middleware pattern
    if (socket.handshake.headers.cookie) {
      const cookies = socket.handshake.headers.cookie
        .split(';')
        .map(cookie => cookie.trim())
        .reduce(
          (acc, cookie) => {
            const [key, value] = cookie.split('=')
            acc[key] = value
            return acc
          },
          {} as Record<string, string>,
        )

      if (cookies.accessToken) {
        token = cookies.accessToken
      }
    }

    // 2. Check socket handshake auth (from client connection)
    if (!token && socket.handshake.auth?.token) {
      token = socket.handshake.auth.token
    }

    // 3. Check query parameters (fallback for some clients)
    else if (!token && socket.handshake.query?.token && typeof socket.handshake.query.token === 'string') {
      token = socket.handshake.query.token
    }

    // 4. Check authorization header
    else if (!token && socket.handshake.headers.authorization) {
      const authHeader = socket.handshake.headers.authorization
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7)
      }
    }

    if (!token) {
      logger.warn('Socket connection rejected: No authentication token provided', {
        correlationId,
        socketId: socket.id,
        ip: socket.handshake.address,
      })

      return next(new SocketAuthenticationError('No authentication token provided', socket.id, correlationId))
    }

    // Verify JWT token (using same secret as HTTP middleware)
    const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET
    if (!ACCESS_TOKEN_SECRET) {
      logger.error('ACCESS_TOKEN_SECRET not configured for socket authentication', {
        correlationId,
        socketId: socket.id,
      })

      return next(new SocketAuthenticationError('Server authentication configuration error', socket.id, correlationId))
    }

    const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET) as AvoqadoJwtPayload

    // SESIONES REVOCABLES: si el token trae `sid`, la sesión debe seguir viva.
    //
    // Un token LEGACY (sin `sid`, emitido antes de este rollout) pasa exactamente como
    // hasta hoy, SIN consultar nada: ahora mismo hay tokens vivos así en dashboard, PAX,
    // Android e iOS, y bloquearlos expulsaría a todo el producto de golpe. Sólo cuando el
    // token SÍ trae `sid` se pregunta a la caché (que cae a la base si hace falta, y nunca
    // acepta por defecto si la consulta falla — ver `sessionCache.ts`).
    if (decoded.sid) {
      const viva = await isSessionAliveCached(decoded.sid)
      if (!viva) {
        logger.warn('Socket connection rejected: session revoked', {
          correlationId,
          socketId: socket.id,
          sessionId: decoded.sid,
        })

        return next(new SocketAuthenticationError('Sesión cerrada. Inicia sesión de nuevo.', socket.id, correlationId))
      }
    }

    // Security Enhancement: Verify venue is operational before allowing connection
    // This prevents TPV at suspended venues from maintaining active socket connections
    // EXCEPTION: SUPERADMIN can connect to any venue for management purposes
    if (decoded.venueId && decoded.venueId !== 'pending' && decoded.role !== 'SUPERADMIN') {
      const venue = await prisma.venue.findUnique({
        where: { id: decoded.venueId },
        select: { id: true, status: true },
      })

      if (!venue || !OPERATIONAL_VENUE_STATUSES.includes(venue.status)) {
        logger.warn('Socket connection rejected: venue not operational', {
          correlationId,
          socketId: socket.id,
          venueId: decoded.venueId,
          venueStatus: venue?.status,
        })

        return next(new SocketAuthorizationError('Venue is not operational. Contact support for assistance.', socket.id, correlationId))
      }
    }

    // Create socket auth context (extends the existing AuthContext pattern)
    const authContext: SocketAuthContext = {
      userId: decoded.sub,
      orgId: decoded.orgId,
      venueId: decoded.venueId,
      role: decoded.role,
      socketId: socket.id,
      connectedAt: new Date(),
      lastActivity: new Date(),
      // Ausente para tokens legacy sin `sid` — es lo que permite a
      // `SocketManager.disconnectBySession` encontrar los sockets de una sesión.
      ...(decoded.sid ? { sessionId: decoded.sid } : {}),
    }

    // Attach auth context to socket (following Express middleware pattern)
    socket.authContext = authContext

    // SESIONES REVOCABLES — cierre por vencimiento: el JWT sólo se verificó UNA VEZ,
    // arriba; a partir de aquí el contexto queda estático mientras el socket siga abierto.
    // Sin este temporizador, revocar la sesión (o que el propio token venza) no cierra la
    // conexión — un access token robado podría abrir un socket segundos antes de vencer y
    // quedarse conectado indefinidamente. Se limpia en `disconnect` para no dejarlo vivo de
    // más (fuga de temporizadores) ni dispararlo sobre un socket que ya se fue por otra
    // razón (p. ej. `disconnectBySession` ya lo cerró por una revocación).
    if (typeof decoded.exp === 'number') {
      const msHastaVencer = Math.max(0, decoded.exp * 1000 - Date.now())
      // Math.min con el tope de arriba — nunca se le pasa a setTimeout un delay mayor
      // al límite de 32 bits, sin importar qué tan lejos esté el exp real del token.
      const msHastaCierre = Math.min(msHastaVencer, SOCKET_LIFETIME_CAP_MS)
      const cierrePorVencimiento = setTimeout(() => {
        logger.info('Socket disconnected: token expired or lifetime cap reached', {
          correlationId,
          socketId: socket.id,
          alcanzoElTope: msHastaVencer > SOCKET_LIFETIME_CAP_MS,
        })
        socket.disconnect(true)
      }, msHastaCierre)
      // onWithContext, no socket.on directo: la regla del módulo (ver
      // tests/unit/observability/socketContext.test.ts, "no file calls socket.on directly").
      onWithContext(socket, 'disconnect', () => clearTimeout(cierrePorVencimiento))
    }

    logger.info('Socket authentication successful', {
      correlationId,
      socketId: socket.id,
      userId: authContext.userId,
      venueId: authContext.venueId,
      role: authContext.role,
      orgId: authContext.orgId,
    })

    next()
  } catch (error) {
    let message = 'Invalid or expired token'

    if (error instanceof jwt.TokenExpiredError) {
      message = 'Token has expired'
      logger.warn('Socket connection rejected: Token expired', {
        correlationId,
        socketId: socket.id,
        expiredAt: error.expiredAt,
      })
    } else if (error instanceof jwt.JsonWebTokenError) {
      message = 'Invalid token format'
      logger.warn('Socket connection rejected: Invalid token', {
        correlationId,
        socketId: socket.id,
        error: error.message,
      })
    } else {
      logger.error('Socket authentication error', {
        correlationId,
        socketId: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })
    }

    next(new SocketAuthenticationError(message, socket.id, correlationId))
  }
}

/**
 * Socket Authorization Middleware Factory
 * Role-based authorization for Socket.IO connections
 * Note: HTTP routes use checkPermission middleware for granular permission-based authorization
 */
export const socketAuthorizationMiddleware = (allowedRoles: string[]) => {
  return (socket: AuthenticatedSocket, next: (err?: Error) => void): void => {
    const correlationId = socket.correlationId || uuidv4()

    try {
      if (!socket.authContext) {
        logger.error('Socket authorization attempted without authentication context', {
          correlationId,
          socketId: socket.id,
        })

        return next(new SocketAuthenticationError('Authentication required before authorization', socket.id, correlationId))
      }

      const userRole = socket.authContext.role

      if (!allowedRoles.includes(userRole)) {
        logger.warn('Socket connection rejected: Insufficient role permissions', {
          correlationId,
          socketId: socket.id,
          userId: socket.authContext.userId,
          userRole,
          allowedRoles,
          venueId: socket.authContext.venueId,
        })

        return next(new SocketAuthenticationError(`Access denied. Required roles: ${allowedRoles.join(', ')}`, socket.id, correlationId))
      }

      logger.info('Socket authorization successful', {
        correlationId,
        socketId: socket.id,
        userId: socket.authContext.userId,
        userRole,
        allowedRoles,
      })

      next()
    } catch (error) {
      logger.error('Socket authorization error', {
        correlationId,
        socketId: socket.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      })

      next(new SocketAuthenticationError('Authorization error', socket.id, correlationId))
    }
  }
}

/**
 * Rate Limiting Middleware for Socket connections
 * Enterprise-grade rate limiting per socket
 */
interface RateLimitConfig {
  windowMs: number
  maxEvents: number
}

const rateLimitMap = new Map<string, { count: number; resetTime: number }>()

export const socketRateLimitMiddleware = (config: RateLimitConfig) => {
  return (socket: AuthenticatedSocket, next: (err?: Error) => void): void => {
    const correlationId = socket.correlationId || uuidv4()
    const identifier = socket.authContext?.userId || socket.handshake.address
    const now = Date.now()

    // Clean up expired entries periodically
    if (Math.random() < 0.1) {
      // 10% chance to cleanup
      for (const [key, value] of rateLimitMap.entries()) {
        if (now > value.resetTime) {
          rateLimitMap.delete(key)
        }
      }
    }

    const existing = rateLimitMap.get(identifier)

    if (!existing || now > existing.resetTime) {
      // New window
      rateLimitMap.set(identifier, {
        count: 1,
        resetTime: now + config.windowMs,
      })
      next()
    } else if (existing.count < config.maxEvents) {
      // Within limits
      existing.count++
      next()
    } else {
      // Rate limited
      logger.warn('Socket rate limit exceeded', {
        correlationId,
        socketId: socket.id,
        identifier,
        count: existing.count,
        maxEvents: config.maxEvents,
        windowMs: config.windowMs,
      })

      next(new SocketAuthenticationError('Rate limit exceeded', socket.id, correlationId))
    }
  }
}
