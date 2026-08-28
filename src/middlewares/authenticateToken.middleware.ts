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
import { isSessionAliveCached } from '../services/auth/sessionCache'
import { ForbiddenError, UnauthorizedError } from '../errors/AppError'

// ────────────────────────────────────────────────────────────────────────────────────────
// SESIONES REVOCABLES — corte del rollout legacy (Parte A, Task 15)
//
// Narrativa completa, la aritmética de los 90 días y quién mueve la bandera:
// `docs/auth-rollout-legacy.md`. Aquí sólo el mecanismo.
//
// Dos entradas independientes — CUALQUIERA de las dos basta para forzar la fase 4
// (rechazar legacy en TODAS partes, no sólo en lo nuevo):
//
//  1. `AUTH_LEGACY_TOKEN_PHASE` — bandera manual (1-4, default 1). La mueve a mano quien
//     opera el rollout, según el checklist del documento de arriba.
//  2. `AUTH_LEGACY_TOKEN_CUTOFF_AT` — fecha de corte YA CALCULADA (ISO 8601). Si ya se
//     cumplió, fuerza fase 4 SOLA, sin que nadie tenga que acordarse de tocar la bandera.
//     Esto es lo que hace que el corte NO dependa de que un humano note que la telemetría
//     llegó a cero: un aparato dormido (una tablet apagada tres semanas) jamás aparece en
//     ninguna métrica, pero el reloj sigue corriendo igual.
//
// Ante cualquier valor ausente o inválido se cae al lado que NUNCA echa a nadie de más
// (fase 1, sin fecha) — el mismo principio que ya usa `passwordChangeGuard.ts`.
const LEGACY_PHASE_ENV_VAR = 'AUTH_LEGACY_TOKEN_PHASE'
const LEGACY_CUTOFF_ENV_VAR = 'AUTH_LEGACY_TOKEN_CUTOFF_AT'

type FaseDelRolloutLegacy = 1 | 2 | 3 | 4

function leerFaseManual(): FaseDelRolloutLegacy {
  const crudo = process.env[LEGACY_PHASE_ENV_VAR]
  const n = crudo === undefined ? NaN : Number(crudo)
  if (!Number.isFinite(n)) return 1
  if (n >= 4) return 4
  if (n === 2 || n === 3) return n
  return 1
}

function leerFechaDeCorte(): Date | null {
  const crudo = process.env[LEGACY_CUTOFF_ENV_VAR]
  if (!crudo) return null
  const fecha = new Date(crudo)
  return Number.isNaN(fecha.getTime()) ? null : fecha
}

/**
 * Fase EFECTIVA del rollout de tokens legacy, en este instante. Exportada porque además de
 * gobernar este middleware es lo que un futuro endpoint de status (o un log de arranque)
 * debería leer, en vez de inventar una segunda fuente de verdad.
 *
 * Las fases 1-3 se comportan IGUAL para este middleware: legacy pasa en rutas normales, y
 * `requireVersionedSession` ya lo rechaza desde el día 1 sin importar la fase — son hitos
 * operativos (ver el documento), no ramas de código. La única transición que el código
 * distingue es "todavía no" vs "fase 4": legacy rechazado en TODAS partes.
 */
export function faseDelRolloutLegacy(): FaseDelRolloutLegacy {
  const manual = leerFaseManual()
  if (manual >= 4) return 4
  const corte = leerFechaDeCorte()
  if (corte && Date.now() >= corte.getTime()) return 4
  return manual
}

/** Cookie primero (Dashboard Web); si no hay, header `Authorization: Bearer` (TPV/API/móvil). */
function extraerToken(req: Request): string | undefined {
  const cookieToken = req.cookies?.accessToken
  if (cookieToken) return cookieToken
  const authHeader = req.headers['authorization']
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7)
  }
  return undefined
}

export const authenticateTokenMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = extraerToken(req)

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

    // SESIONES REVOCABLES: si el token trae `sid`, la sesión debe seguir viva.
    //
    // Un token LEGACY (sin `sid`, emitido antes de este rollout) pasa exactamente como
    // hasta hoy, SIN consultar nada: ahora mismo hay tokens vivos de dashboard, PAX,
    // Android e iOS sin `sid`, y bloquearlos expulsaría a todo el producto de golpe. Solo
    // cuando el token SÍ trae `sid` se pregunta a la caché (que cae a la base si Redis no
    // responde, y nunca acepta por defecto si las dos fallan).
    //
    // Eso es cierto MIENTRAS la fase efectiva del rollout no llegue a 4 — ver
    // `faseDelRolloutLegacy` arriba y `docs/auth-rollout-legacy.md`.
    if (decoded.sid) {
      const viva = await isSessionAliveCached(decoded.sid)
      if (!viva) {
        return next(new UnauthorizedError('Sesión cerrada. Inicia sesión de nuevo.'))
      }
    } else if (faseDelRolloutLegacy() >= 4) {
      // FASE 4: pasada la fecha de corte (o forzada a mano con AUTH_LEGACY_TOKEN_PHASE=4),
      // un token SIN `sid` ya no se acepta en NINGUNA ruta — ni siquiera las de siempre.
      // El corte es sobre la AUSENCIA de `sid`: un token CON sid nunca cae en esta rama, sin
      // importar qué tan vieja sea la fecha de corte (arriba, en el `if`).
      return next(
        new UnauthorizedError('Tu sesión es de una versión anterior y ya no se admite. Inicia sesión de nuevo.', 'LEGACY_TOKEN_RETIRED'),
      )
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

/**
 * Candado de "lo nuevo" — la Parte C construye `switch-user` MONTADO sobre este guard, en la
 * cadena de la ruta, DESPUÉS de `authenticateTokenMiddleware`. Un token SIN `sid` jamás pasa
 * por aquí, desde el día 1 de la fase 1, sin importar `faseDelRolloutLegacy` ni la fecha de
 * corte: lo nuevo nace exigiendo identidad de sesión, no espera al rollout. Ver
 * `docs/auth-rollout-legacy.md` (Fase 3).
 *
 * Vuelve a verificar el JWT en vez de leer `req.authContext` (que no expone `sid`/`v`) para
 * no tener que ampliar `AuthContext` — ese tipo lo consume medio backend y esta tarea no lo
 * toca. El costo es un `jwt.verify` extra por petición, sólo en las rutas que usan este
 * guard: insignificante comparado con ampliar una interfaz compartida por el resto del repo.
 */
export const requireVersionedSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = extraerToken(req)
    if (!token) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'No authentication token provided',
      })
      return
    }

    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!, {
      algorithms: ['HS256'],
    }) as AvoqadoJwtPayload

    if (!decoded.sid) {
      return next(
        new ForbiddenError(
          'Esta operación requiere una sesión con identidad de dispositivo. Vuelve a iniciar sesión.',
          'LEGACY_TOKEN_NOT_ALLOWED',
        ),
      )
    }

    next()
  } catch {
    // Defensivo: en la cadena real `authenticateTokenMiddleware` ya habría atrapado un token
    // ausente/vencido/inválido antes de llegar aquí. Este guard no es la autenticación
    // primaria, sólo la exigencia extra de versión — por eso no distingue el motivo.
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    })
  }
}
