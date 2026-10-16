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

function rechazo(req: Request, res: Response): void {
  logger.warn('🚨 Límite de consultas de tarjetas de regalo excedido', { venueId: req.params.venueId, ipAddress: req.ip })
  res.status(429).json({
    success: false,
    code: 'GIFT_CARD_LOOKUP_RATE_LIMITED',
    message: 'Demasiadas consultas de tarjetas de regalo seguidas. Espera un minuto y vuelve a intentar.',
    retryAfter: 60,
  })
}

/**
 * Fábrica (las pruebas la usan con topes chicos); las rutas usan las instancias de abajo. Orden: IP, luego aparato.
 * `soloFallos`: sólo cuentan las respuestas ≥ 400. `prefijo` va al inicio de las dos llaves.
 */
export function crearLimitadoresDeConsulta(
  maxPorAparato: number,
  maxPorIp: number,
  opciones: { soloFallos?: boolean; prefijo?: string } = {},
): RateLimitRequestHandler[] {
  const prefijo = opciones.prefijo ?? 'gift-card-lookup'
  const comun = {
    windowMs: VENTANA_MS,
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
