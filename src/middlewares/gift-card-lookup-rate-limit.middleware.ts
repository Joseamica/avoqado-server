/**
 * Límite de consultas de tarjetas de regalo por código (spec §6: «la consulta tiene límite de intentos por aparato e IP»).
 *
 * El código tiene ~80 bits: adivinarlo no es el riesgo. Lo es un aparato robado o una sesión filtrada probando códigos de
 * fotos o de tickets tirados. Dos topes juntos, en memoria (una sola instancia, sin Redis):
 *   · por APARATO (`X-Device-Id`): una caja consulta una tarjeta por cliente; 30 en un minuto ya es barrido;
 *   · por IP: varias cajas salen por el mismo WiFi, así que su tope es más holgado (120 por minuto).
 * El servicio (`lookupGiftCardsByCode`, A8) además cuenta los FALLOS; esto sólo pone el techo de volumen.
 *
 * Nota 1 del coordinador (A8 «oráculo de códigos»): cobrar con saldo responde 404 a un código que no existe, así que sin
 * tope serviría para probar códigos. `giftCardPayFailureRateLimiters` cuenta SÓLO las respuestas ≥ 400 (`soloFallos`): un
 * cobro que sale bien nunca gasta el tope. Su `prefijo` propio separa sus contadores de los de la consulta.
 */
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit'
import type { Request, Response } from 'express'
import logger from '@/config/logger'
import { aparatoDe } from '@/utils/giftCardRequest'

const isProd = process.env.NODE_ENV === 'production'
const VENTANA_MS = 60 * 1000

const ipDe = (req: Request): string => req.ip || req.socket.remoteAddress || 'desconocida'
const negocioDe = (req: Request): string => req.params.venueId || 'sin-negocio'

/**
 * Fábrica (las pruebas la usan con topes chicos); las rutas usan las instancias de abajo. Orden: IP, luego aparato.
 * `soloFallos`: sólo cuentan las respuestas ≥ 400. `prefijo` va al inicio de las dos llaves. 1b S4 (A28): `code`, `mensaje` y
 * `ventanaMs` propios; el 429 dice `retryAfter` = la ventana en segundos (sin `ventanaMs`, 60 como siempre).
 */
export function crearLimitadoresDeConsulta(
  maxPorAparato: number,
  maxPorIp: number,
  opciones: { soloFallos?: boolean; prefijo?: string; code?: string; mensaje?: string; ventanaMs?: number } = {},
): RateLimitRequestHandler[] {
  const prefijo = opciones.prefijo ?? 'gift-card-lookup'
  const ventanaMs = opciones.ventanaMs ?? VENTANA_MS
  // ⭐ (C3 menor 1): el texto y la línea del log son de ESTE limitador. Cobrar con saldo (`soloFallos`) habla de intentos de cobro
  // —lo ve la cajera—; el `code` es el mismo para los dos (la app ya decide por él).
  const cobro = opciones.soloFallos === true
  const rechazo = (req: Request, res: Response): void => {
    logger.warn(
      cobro ? '🚨 Límite de intentos de cobro con tarjeta de regalo excedido' : '🚨 Límite de consultas de tarjetas de regalo excedido',
      {
        limiter: prefijo,
        venueId: req.params.venueId,
        ipAddress: req.ip,
      },
    )
    res.status(429).json({
      success: false,
      code: opciones.code ?? 'GIFT_CARD_LOOKUP_RATE_LIMITED',
      message:
        opciones.mensaje ??
        (cobro
          ? 'Demasiados intentos de cobro con tarjeta de regalo seguidos. Espera un minuto y vuelve a intentar.'
          : 'Demasiadas consultas de tarjetas de regalo seguidas. Espera un minuto y vuelve a intentar.'),
      retryAfter: ventanaMs / 1000,
    })
  }
  const comun = {
    windowMs: ventanaMs,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: opciones.soloFallos === true,
    handler: rechazo,
  }
  const porIp = rateLimit({
    ...comun,
    max: maxPorIp,
    keyGenerator: (req: Request) => `${prefijo}:ip:${negocioDe(req)}:${ipDe(req)}`,
  })
  const porAparato = rateLimit({
    ...comun,
    max: maxPorAparato,
    keyGenerator: (req: Request) => {
      const aparato = aparatoDe(req)
      return aparato ? `${prefijo}:device:${negocioDe(req)}:${aparato}` : `${prefijo}:device-ip:${negocioDe(req)}:${ipDe(req)}`
    },
  })
  return [porIp, porAparato]
}

export const giftCardLookupRateLimiters = crearLimitadoresDeConsulta(isProd ? 30 : 1000, isProd ? 120 : 1000)

/** Cobrar con saldo: sólo los intentos FALLIDOS gastan el tope (nota 1 del coordinador). */
export const giftCardPayFailureRateLimiters = crearLimitadoresDeConsulta(isProd ? 30 : 1000, isProd ? 120 : 1000, {
  soloFallos: true,
  prefijo: 'gift-card-pay',
})

/**
 * 1b S4 (S-5): mostrar el código. Las TRES rutas (`reveal`, `reveal-manager` y `orders/:orderId/reveal`) montan ESTA instancia:
 * un solo contador, y una petición cuenta una vez aunque traiga varias tarjetas.
 */
export const giftCardRevealRateLimiters = crearLimitadoresDeConsulta(isProd ? 10 : 1000, isProd ? 30 : 1000, {
  prefijo: 'gift-card-reveal',
  mensaje: 'Demasiadas veces seguidas mostrando códigos. Espera un minuto.',
})
