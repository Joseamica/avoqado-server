import { Request, Response, NextFunction } from 'express'
import { v4 as uuidv4 } from 'uuid'
import logger from '../config/logger' // Ajusta la ruta si es necesario

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
  const correlationId = req.headers['x-correlation-id'] || uuidv4()
  req.correlationId = correlationId as string
  res.setHeader('X-Correlation-ID', correlationId)

  const start = process.hrtime()
  const { method, url, ip } = req

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

    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info'

    if (!shouldSkipLogging) {
      logger.log(level, `Request End: ${method} ${url} - ${statusCode} [${duration}ms]`, {
        correlationId,
        method,
        url,
        statusCode,
        durationMs: parseFloat(duration),
        ip,
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
}
