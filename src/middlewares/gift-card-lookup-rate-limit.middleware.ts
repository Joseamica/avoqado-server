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
import type { GiftCardErrorCode } from '@/services/giftCards/giftCardErrors'
import { aparatoDe } from '@/utils/giftCardRequest'

const isProd = process.env.NODE_ENV === 'production'
const VENTANA_MS = 60 * 1000

const ipDe = (req: Request): string => req.ip || req.socket.remoteAddress || 'desconocida'
const negocioDe = (req: Request): string => req.params.venueId || 'sin-negocio'

/**
 * El 429 de TODOS los limitadores de tarjetas, el que lee la app: `{ success: false, code, message, retryAfter }` (`retryAfter` = la
 * ventana en segundos), con su línea de log (`limiter` dice cuál frenó; sin código, teléfono ni correo).
 */
function rechazoDelLimite(o: {
  prefijo: string
  aviso: string
  code: string
  mensaje: string
  ventanaMs: number
  datos?: (req: Request) => Record<string, unknown>
}) {
  return (req: Request, res: Response): void => {
    logger.warn(o.aviso, { limiter: o.prefijo, venueId: req.params.venueId, ipAddress: req.ip, ...o.datos?.(req) })
    res.status(429).json({ success: false, code: o.code, message: o.mensaje, retryAfter: o.ventanaMs / 1000 })
  }
}

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
  const rechazo = rechazoDelLimite({
    prefijo,
    aviso: cobro
      ? '🚨 Límite de intentos de cobro con tarjeta de regalo excedido'
      : '🚨 Límite de consultas de tarjetas de regalo excedido',
    code: opciones.code ?? 'GIFT_CARD_LOOKUP_RATE_LIMITED',
    mensaje:
      opciones.mensaje ??
      (cobro
        ? 'Demasiados intentos de cobro con tarjeta de regalo seguidos. Espera un minuto y vuelve a intentar.'
        : 'Demasiadas consultas de tarjetas de regalo seguidas. Espera un minuto y vuelve a intentar.'),
    ventanaMs,
  })
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

/**
 * 1b S5 (S-2): teléfono + código. Pedir y verificar llevan contadores PROPIOS (por aparato y por IP, ventana de 10 min) con el mismo
 * `code`; el límite por TELÉFONO (uno cada 30 s, 5 por hora) lo cuenta el servicio con los retos de la base.
 */
const DEL_TELEFONO = {
  code: 'GIFT_CARD_PHONE_RATE_LIMITED',
  mensaje: 'Ya pedimos varios códigos para ese teléfono. Espera unos minutos.',
  ventanaMs: 10 * 60 * 1000,
}
export const giftCardPhoneRequestRateLimiters = crearLimitadoresDeConsulta(isProd ? 10 : 1000, isProd ? 30 : 1000, {
  ...DEL_TELEFONO,
  prefijo: 'gift-card-phone-request',
})
export const giftCardPhoneVerifyRateLimiters = crearLimitadoresDeConsulta(isProd ? 20 : 1000, isProd ? 60 : 1000, {
  ...DEL_TELEFONO,
  prefijo: 'gift-card-phone-verify',
})

/**
 * Cierre A (C4, M3 de la revisión final): reenviar una tarjeta. Cada reenvío nuevo es un WhatsApp o un correo que cuesta, y los
 * reportes de spam bajan la calificación del número de WhatsApp de Avoqado (el mismo de los códigos de inicio de sesión). UN
 * contador por (negocio, tarjeta) que comparten `resend` y `change-destination` del POS y el `resend` del panel: 5 por hora.
 *  - Sólo gasta el tope lo que SÍ manda algo nuevo: una respuesta < 400 que no sea la repetición de una llave. El controller marca
 *    la repetición con `marcarRepeticionDeReenvio` ANTES de responder; al terminar la respuesta, la repetición, los rechazos
 *    (4xx/5xx) y el propio 429 se descuentan (`skipFailedRequests`).
 *  - ponytail: una repetición que llega con el tope ya lleno recibe el 429 (no cuenta, pero espera como las demás): el contador
 *    corre antes del servicio y sólo el servicio sabe, bajo el candado de la tarjeta, que es una repetición.
 *  - `retryAfter` es la ventana entera (3600), como en los demás limitadores de ruta; el contador real puede liberarse antes.
 * Mismo molde y mismo 429 que `crearLimitadoresDeConsulta` (`rechazoDelLimite`); memoria de UNA instancia
 * (`.claude/rules/una-sola-instancia.md`, punto 11). La llave es por tarjeta, no por IP ni aparato: el límite cuida al
 * destinatario y al número, no a la caja.
 */
const REPETICION_DE_REENVIO = 'giftCardResendReplay'
const CODIGO_DE_REENVIO: GiftCardErrorCode = 'GIFT_CARD_RESEND_RATE_LIMITED'
export const MENSAJE_DE_REENVIO = 'Ya reenviamos esta tarjeta varias veces. Espera un rato y vuelve a intentar.'

/**
 * La respuesta es la repetición de una llave de reenvío (no mandó nada nuevo): no gasta el tope de reenvíos. En Express `res.locals`
 * siempre existe; un `res` armado a mano (una prueba que llama al controller directo) puede no traerlo, y marcar nunca debe tumbar
 * la respuesta de una repetición.
 */
export function marcarRepeticionDeReenvio(res: Response): void {
  if (res.locals) res.locals[REPETICION_DE_REENVIO] = true
}

export function crearLimiteDeReenvio(max: number, ventanaMs: number = 60 * 60 * 1000): RateLimitRequestHandler {
  const prefijo = 'gift-card-resend'
  return rateLimit({
    windowMs: ventanaMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    requestWasSuccessful: (_req: Request, res: Response) => res.statusCode < 400 && res.locals?.[REPETICION_DE_REENVIO] !== true,
    keyGenerator: (req: Request) => `${prefijo}:card:${negocioDe(req)}:${req.params.giftCardId ?? 'sin-tarjeta'}`,
    handler: rechazoDelLimite({
      prefijo,
      aviso: '🚨 Límite de reenvíos de una tarjeta de regalo excedido',
      code: CODIGO_DE_REENVIO,
      mensaje: MENSAJE_DE_REENVIO,
      ventanaMs,
      datos: req => ({ giftCardId: req.params.giftCardId }),
    }),
  })
}

/** Las TRES rutas (`resend` y `change-destination` del POS, `resend` del panel) montan ESTA instancia: un solo contador. */
export const giftCardResendRateLimiter = crearLimiteDeReenvio(isProd ? 5 : 1000)
