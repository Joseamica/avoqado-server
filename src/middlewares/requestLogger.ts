import { Request, Response, NextFunction } from 'express'
import logger from '../config/logger' // Ajusta la ruta si es necesario
import { runWithContext } from '../observability/executionContext'
import { CORRELATION_HEADER, resolveCorrelationId } from '../observability/correlationId'
import { normalizeEntrypoint, redactPathSecrets } from '../observability/entrypoint'

/** Parámetros de query cuyo VALOR nunca puede llegar a un log. */
const PARAMS_SENSIBLES = new Set([
  'code', // 🔴 el de OAuth: canjea un token mientras no expire
  'state',
  'intent', // 🔴 el enlace firmado de conexión de Uber (`/oauth/start?intent=`): con él se conectan tiendas a un negocio
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'client_secret',
  'secret',
  'password',
  'api_key',
  'apikey',
  'signature',
  'hub.verify_token', // 🔴 el secreto del handshake de WhatsApp: Meta lo manda en el query (GET /api/v1/webhooks/whatsapp)
])

/**
 * Redacta credenciales del query string, dejando el resto de la URL legible.
 *
 * `normalizeEntrypoint` ya borra el query string entero, pero eso alimenta el campo
 * `entrypoint`; el logger ADEMÁS escribe la URL cruda en `Request Start`/`Request End`, que
 * es donde se filtraban. Ante una query malformada se redacta entera: perder legibilidad es
 * preferible a filtrar un secreto.
 */
export function redactUrlSecrets(url: string): string {
  // 🔴 Además del query: hay rutas cuyo SEGMENTO es el secreto (webhooks de pases, ver `redactPathSecrets`).
  const i = url.indexOf('?')
  if (i === -1) return redactPathSecrets(url, '[redactado]')

  const ruta = redactPathSecrets(url.slice(0, i), '[redactado]')
  const query = url.slice(i + 1)

  try {
    const params = new URLSearchParams(query)
    let tocado = false
    for (const clave of [...params.keys()]) {
      if (PARAMS_SENSIBLES.has(clave.toLowerCase())) {
        params.set(clave, '[redactado]')
        tocado = true
      }
    }
    return tocado ? `${ruta}?${params.toString()}` : `${ruta}?${query}`
  } catch {
    return `${ruta}?[query-redactada]`
  }
}

/**
 * Middleware para registrar todos los requests en el logger.
 *
 * Genera un X-Correlation-ID para cada request y lo registra en el logger al
 * principio y al final de cada request, con el tiempo de respuesta en milisegundos.
 *
 * Si la conexión se cierra prematuramente (cliente se desconecta), se registra
 * un mensaje de advertencia en el logger.
 */
export const requestLoggerMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // 🔴 Ya lo abrió un logger montado más arriba (los explícitos de /api/v1/public y de los webhooks, que van antes de
  // `configureCoreMiddlewares`): una ruta que no casa sigue hasta el logger general, y dos loggers dejaban DOS `Request End`
  // con dos correlationId distintos para una sola petición. El contexto del primero sigue activo aquí.
  if (req.correlationId) return next()

  // A client-supplied id is reused only when it is safe to (see correlationId.ts): it ends
  // up in log fields, and Express hands back an array when a header arrives twice.
  const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER])
  req.correlationId = correlationId
  res.setHeader('X-Correlation-ID', correlationId)

  // 🔴 `originalUrl`, no `url`: dentro de un `app.use('/prefijo', …)` Express le quita el prefijo a `req.url`, y el
  // montaje explícito de /api/v1/public registraba `GET /receipt/:id` en vez de `GET /api/v1/public/receipt/:id`.
  const fullUrl = req.originalUrl ?? req.url

  // Everything below runs INSIDE the execution context, including the res listeners
  // registered here. Wrapping only next() would leave the request-completion log — the one
  // line people actually search — without a tenant.
  runWithContext({ correlationId, source: 'http', entrypoint: normalizeEntrypoint(req.method, fullUrl) }, () => {
    const start = process.hrtime()
    const { method, ip } = req
    // 🔴 NUNCA la URL cruda: el query string carga credenciales. El callback de OAuth recibe
    // `?code=…&state=…`, y ese código canjea un token si alguien lo lee del log antes de que
    // expire. Hallado por auditoría externa el 2026-08-20.
    const url = redactUrlSecrets(fullUrl)

    // Skip logging health checks and heartbeats to reduce log noise (in all environments)
    const isHealthCheck = url === '/health'
    const isHeartbeat = url.includes('/heartbeat') || url.includes('/tpv/heartbeat')
    const shouldSkipLogging = isHealthCheck || isHeartbeat

    const shouldLogStart = !shouldSkipLogging && process.env.NODE_ENV !== 'development'

    if (shouldLogStart) {
      logger.info(`Request Start: ${method} ${url}`, {
        correlationId,
        method,
        url,
        ip,
        userAgent: req.headers['user-agent'],
      })
    }

    res.on('finish', () => {
      const diff = process.hrtime(start)
      const duration = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(3) // milliseconds
      const { statusCode } = res

      // Un 404 que NINGÚN router atendió (`req.route` vacío) es un escáner de internet o una URL vieja (`/.env`, `wp-admin`,
      // `/graphql`: ~920 líneas en 3 días de producción, 30-sep-2026), no un aviso del sistema: info. Un 404 que sí atendió un
      // handler («el recurso no existe») y cualquier otro 4xx siguen en warn. Límite conocido: un 404 que contestara un
      // middleware montado con `use()` (sin ruta) también bajaría a info; hoy ninguno lo hace (los que contestan 404 —
      // resolveVenueBySlug, bindTpv*Target— van dentro de la ruta, y `checkPublicVenueFeature` deja pasar al controlador).
      const sinRuta = statusCode === 404 && !req.route
      // Un handler puede declarar que su respuesta es un desenlace ESPERADO (`res.locals.requestEndLevel`): la espera de un cobro
      // que el cajero canceló cierra con 504 a propósito y no es una falla (3-oct-2026: los 9 «Error 504» de un día eran eso).
      // Sólo se aceptan info/warn; cualquier otro valor se ignora y decide el status.
      const declarado = res.locals?.requestEndLevel
      const level =
        declarado === 'info' || declarado === 'warn'
          ? declarado
          : statusCode >= 500
            ? 'error'
            : statusCode >= 400 && !sinRuta
              ? 'warn'
              : 'info'

      if (!shouldSkipLogging) {
        // Enrich logs with auth context (available after auth middleware runs)
        const authContext = (req as any).authContext
        const authFields: Record<string, any> = {}
        if (authContext) {
          authFields.userId = authContext.userId
          authFields.venueId = authContext.venueId
          authFields.role = authContext.role
          if (authContext.terminalSerialNumber) {
            authFields.terminal = authContext.terminalSerialNumber
          }
        }

        logger.log(level, `Request End: ${method} ${url} - ${statusCode} [${duration}ms]`, {
          correlationId,
          method,
          url,
          statusCode,
          durationMs: parseFloat(duration),
          ip,
          ...authFields,
        })
      }
    })

    res.on('close', () => {
      // Este evento se dispara si la conexión se cierra prematuramente (cliente se desconecta)
      // 'finish' podría no dispararse en este caso.
      if (!res.writableEnded && !shouldSkipLogging) {
        // writableEnded es true si finish se disparó
        const diff = process.hrtime(start)
        const duration = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(3)
        logger.warn(`Request Closed Prematurely: ${method} ${url} [after ${duration}ms]`, {
          correlationId,
          method,
          url,
          durationMs: parseFloat(duration),
          ip,
          userAgent: req.headers['user-agent'],
        })
      }
    })

    next()
  })
}
