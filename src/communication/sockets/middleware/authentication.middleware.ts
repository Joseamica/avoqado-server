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
 * Cada cuánto se revalida, SOBRE EL MISMO SOCKET, que la sesión sigue viva y que
 * el token no ha vencido.
 *
 * 🔴 [Auditoría, SEGUNDO hallazgo Crítico] La primera versión de este candado
 * cerraba el socket al cumplirse un tope de vida (24h) o el `exp` real, confiando
 * en que el cliente reconectaría solo. NO reconecta solo: cuando es EL SERVIDOR
 * quien llama `socket.disconnect()`, Socket.IO manda `reason: "io server
 * disconnect"`, y tanto `socket.io-client` (JS) como `socket.io-client-java` SE
 * SALTAN la reconexión automática a propósito para esa razón — el propio código
 * fuente de esos clientes dice que hace falta reconectar A MANO. Ninguno de
 * nuestros clientes lo hace: el dashboard (`SocketContext.tsx`) sólo marca
 * `isConnected=false`, y la TPV (`SocketManager.kt`) sólo loguea — su único
 * camino de reconexión es un 401, que un cierre "sano" nunca dispara. Con el
 * tope de 24h, una terminal PAX perdía el socket cada día y se quedaba MUDA hasta
 * que alguien reiniciara la app a mano, sin un solo error visible — cambiamos un
 * bug ruidoso (se notaba enseguida) por uno silencioso y recurrente, peor para
 * una terminal desatendida.
 *
 * La solución no es cerrar sockets sanos: es REVALIDARLOS sin cerrarlos. Cada
 * `REVALIDATION_INTERVAL_MS` se comprueba, sobre el MISMO socket ya conectado,
 * que la sesión sigue viva (`isSessionAliveCached`, sólo si el token trae `sid`)
 * y que el token no venció (`exp`, SIEMPRE, tenga o no `sid` — un legacy también
 * puede vencer) — y sólo si algo de eso falla se desconecta. Un socket legítimo
 * NUNCA se cierra por esto, así que no depende de una reconexión que no existe;
 * cuando SÍ desconecta es porque de verdad hay que echar a alguien, y ahí que el
 * cliente no reconecte solo es lo correcto — necesita credenciales nuevas, no las
 * mismas otra vez. El desborde de 32 bits desaparece por construcción: un
 * intervalo de minutos nunca se acerca al límite de ~24.8 días.
 *
 * 10 minutos, no 5: `disconnectBySession` ya es el camino EAGER (dispara al
 * instante de revocar, sin esperar nada) — este intervalo es sólo la red de
 * seguridad de fondo para lo que ese camino pudiera perderse (o para el `exp`
 * mismo, que nadie más vigila). 10 minutos deja esa ventana de exposición muy por
 * debajo de cualquier duración real de token (1h a 30 días) sin más costo del
 * necesario: `isSessionAliveCached` cachea 60s, así que CADA revalidación es un
 * cache-miss que toca la base — a un socket por 10 minutos, incluso con miles de
 * sockets abiertos a la vez eso es un puñado de consultas por segundo, nunca
 * carga real. Es, además, el tope real de exposición de esta tarea: no las 24h
 * de la versión anterior, sino estos 10 minutos.
 */
export const REVALIDATION_INTERVAL_MS = 10 * 60 * 1000 // 10 minutos

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
 *  - si el token trae `sid`, la sesión debe seguir viva en el handshake (mismo contrato que
 *    `authenticateTokenMiddleware`, del lado HTTP);
 *  - el socket queda bajo revalidación PERIÓDICA mientras siga conectado (ver
 *    `REVALIDATION_INTERVAL_MS` arriba) — desconectar sólo al revocar no basta, porque un
 *    access token robado podría abrir un socket y quedarse conectado hasta que su `exp` real
 *    llegue, que puede ser semanas después; y un candado de una sola vez al `exp` tampoco
 *    basta, porque cerrar un socket sano no hace que el cliente reconecte solo.
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

    // SESIONES REVOCABLES — revalidación periódica: ver el docstring de
    // REVALIDATION_INTERVAL_MS arriba para el porqué de este diseño (no cerrar sockets
    // sanos). El JWT sólo se verificó UNA VEZ, arriba, en el handshake — a partir de aquí
    // el contexto queda estático salvo por esta revalidación, que corre sobre el MISMO
    // socket sin desconectarlo mientras todo siga en orden.
    if (typeof decoded.exp === 'number') {
      const revalidar = async (): Promise<void> => {
        const cerrar = (motivo: string, extra?: Record<string, unknown>) => {
          logger.info(`Socket disconnected: ${motivo} (periodic revalidation)`, {
            correlationId,
            socketId: socket.id,
            ...extra,
          })
          clearInterval(intervaloRevalidacion)
          socket.disconnect(true)
        }

        try {
          // Sólo si el token trae `sid` — un legacy no tiene sesión que consultar, pero
          // SÍ tiene `exp`, que se comprueba abajo sin importar `sid`.
          if (decoded.sid) {
            const viva = await isSessionAliveCached(decoded.sid)
            if (!viva) {
              cerrar('session revoked', { sessionId: decoded.sid })
              return
            }
          }

          if (Date.now() >= decoded.exp! * 1000) {
            cerrar('token expired')
          }
        } catch (error) {
          // Falla CERRADO: si no se puede confirmar que la sesión sigue viva (la base
          // truena, etc.), NO se deja el socket abierto "por si acaso" — misma regla que
          // `isSessionAliveCached` (sessionCache.ts): nunca aceptar por defecto.
          cerrar('revalidation failed, failing closed', {
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      const intervaloRevalidacion = setInterval(revalidar, REVALIDATION_INTERVAL_MS)
      // onWithContext, no socket.on directo: la regla del módulo (ver
      // tests/unit/observability/socketContext.test.ts, "no file calls socket.on directly").
      // Limpiar el intervalo es tan obligatorio como lo era limpiar el temporizador — uno
      // colgado por socket, en un proceso que corre semanas, es una fuga peor que la del
      // setTimeout original.
      onWithContext(socket, 'disconnect', () => clearInterval(intervaloRevalidacion))
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
