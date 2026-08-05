/**
 * Guardia de retención del event loop.
 *
 * Node atiende de uno en uno. Cuando un handler hace CPU síncrono, todas las demás
 * peticiones esperan formadas. El 2026-08-04 eso llevó a `/dashboard/auth/status` —que no
 * hace nada pesado— a tardar 33.7 s mientras la pantalla de Ventas de PlayTelecom hacía
 * cuentas fila por fila.
 *
 * El guardia NO previene: detecta y NOMBRA al culpable. Mantiene el registro de las
 * peticiones en vuelo y, cuando el hilo se retiene más del umbral, las escribe al log con
 * la más vieja primero — que es casi siempre la que está bloqueando.
 *
 * 🔴 NO es duplicado del `eventLoopHistogram` de `app.ts:52`. Son dos cosas distintas y
 * ninguna sustituye a la otra:
 *
 *   - `eventLoopHistogram` (`monitorEventLoopDelay`) alimenta el tablero de superadmin con
 *     estadísticas agregadas (`lagMs`, `lagP99Ms`, `lagMaxMs` en `app.ts:277`). NUNCA se
 *     resetea, así que su `max` es el máximo histórico desde que arrancó el proceso — tras
 *     el incidente del 2026-08-04 marcaría 33,000 ms hasta el siguiente deploy. Sirve para
 *     mirar, no para alertar. Y resetearlo aquí rompería ese endpoint.
 *   - Este guardia responde otra pregunta: *¿QUIÉN* está reteniendo el hilo ahora mismo?
 *     Eso el histograma no lo sabe: es un número global, sin ruta.
 *
 * Si algún día se unifican, hay que resolver primero el conflicto de reset.
 *
 * 🔴 Nota de operación (2026-08-04): los 4 monitores de uptime de Better Stack están
 * PAUSADOS desde el 26-jun-2026, y ninguna de las 5 alertas configuradas vigila lentitud
 * (todas miran errores; un 200 OK de 33 s les es invisible). Mientras eso siga así, este
 * log es la ÚNICA vía de enterarse. Ver §6.2 del spec.
 */
import type { Request, Response, NextFunction } from 'express'
import logger from '../config/logger'

/**
 * Umbral de aviso en producción.
 *
 * Más flojo que el de CI (50 ms, ver `eventLoopBudget.ts`) a propósito: en CI un falso
 * positivo cuesta rehacer un test; en producción cuesta que la gente aprenda a ignorar las
 * alertas, y una alerta ignorada no sirve de nada. Se aprieta cuando el ruido de las
 * primeras semanas esté medido.
 */
const PROD_ALERT_THRESHOLD_MS = Number(process.env.EVENT_LOOP_ALERT_MS) || 200

const DEFAULT_SAMPLE_INTERVAL_MS = 20

/** Tope duro del registro. Si algo dejara de emitir 'finish', esto evita una fuga de memoria. */
const MAX_TRACKED_REQUESTS = 500

interface InFlightRequest {
  method: string
  url: string
  startedAt: number
}

const inFlight = new Map<symbol, InFlightRequest>()

/**
 * Anota la petición mientras está en vuelo.
 *
 * Nunca estorba: pase lo que pase llama a `next()`. Un guardia de observabilidad jamás
 * puede ser la razón por la que una petición falla — menos aún en el camino de cobro.
 */
export function eventLoopGuardMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = Symbol('req')

  if (inFlight.size >= MAX_TRACKED_REQUESTS) {
    const oldest = inFlight.keys().next()
    if (!oldest.done) inFlight.delete(oldest.value)
  }

  inFlight.set(key, {
    method: req.method,
    url: req.originalUrl ?? (req as unknown as { url?: string }).url ?? 'desconocida',
    startedAt: Date.now(),
  })

  const release = () => {
    inFlight.delete(key)
  }
  res.on('finish', release)
  res.on('close', release) // el cliente cortó: igual hay que soltarla

  next()
}

export function getInFlightRequests(): Array<{ method: string; url: string; ageMs: number }> {
  const now = Date.now()
  return Array.from(inFlight.values()).map(r => ({
    method: r.method,
    url: r.url,
    ageMs: now - r.startedAt,
  }))
}

/**
 * Arranca el muestreo del lag. Devuelve la función para detenerlo.
 *
 * Si un tick del intervalo llega tarde, ese retraso ES el tiempo que el hilo estuvo
 * secuestrado. Cuando pasa del umbral se loguean las peticiones en vuelo.
 */
export function startEventLoopMonitor(options: { thresholdMs?: number; sampleIntervalMs?: number } = {}): () => void {
  const thresholdMs = options.thresholdMs ?? PROD_ALERT_THRESHOLD_MS
  const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS

  let lastTick = process.hrtime.bigint()

  const sampler = setInterval(() => {
    const now = process.hrtime.bigint()
    const blockedMs = Number(now - lastTick) / 1e6 - sampleIntervalMs
    lastTick = now

    if (blockedMs > thresholdMs) {
      const culprits = getInFlightRequests().sort((a, b) => b.ageMs - a.ageMs)
      logger.warn('[event-loop] hilo retenido', {
        blockedMs: Math.round(blockedMs),
        thresholdMs,
        inFlightCount: culprits.length,
        // La más vieja primero: la que lleva más tiempo corriendo suele ser la que bloquea.
        topInFlight: culprits.slice(0, 5),
      })
    }
  }, sampleIntervalMs)

  if (typeof sampler.unref === 'function') sampler.unref()

  return () => clearInterval(sampler)
}

/** Sólo para tests: limpia el registro entre casos. */
export function __resetInFlightForTests(): void {
  inFlight.clear()
}
