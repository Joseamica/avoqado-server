/**
 * Límites del código de verificación de 6 dígitos (alta desde la landing y alta del dashboard).
 *
 * Viven aquí, en UN módulo, para que `/onboarding/verify-email`, `/onboarding/resend-verification`
 * y `/public/contact` compartan las MISMAS instancias: el contador de envíos de un correo es uno
 * solo, entre todas las puertas que mandan un código.
 *
 * Todos cuentan por CORREO y dejan la IP real como respaldo (`llavePorCorreoOIp`): detrás de
 * Cloudflare y del proxy de la landing, muchos visitantes comparten IP. Ver `utils/clientIp`.
 */
// ponytail: límite en memoria; vale mientras el SERVIDOR sea una sola instancia
import type { RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { altaLandingConCodigo } from '../config/altaLandingConCodigo'
import { ipDelCliente, llavePorCorreoOIp } from '../utils/clientIp'

// Más permisivo en desarrollo para poder probar a mano.
const isDevelopment = process.env.NODE_ENV !== 'production'

/** Marca de `res.locals` con la que `/contact` pide que el 429 salga en JSON y en español. */
const RESPUESTA_EN_JSON = 'limiteDeCodigoEnJson'

/** Adivinar el código: 5 intentos por correo cada 15 minutos (en desarrollo, 50). */
export const limiteIntentosDeCodigo = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 50 : 5, // Dev: 50/15min, Prod: 5/15min
  message: 'Too many verification attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: llavePorCorreoOIp,
  handler: (_req, res, _next, options) => {
    if (res.locals[RESPUESTA_EN_JSON]) {
      res.status(options.statusCode).json({
        success: false,
        code: 'DEMASIADOS_INTENTOS',
        message: 'Hiciste demasiados intentos. Espera unos minutos y pide un código nuevo.',
      })
      return
    }
    // Idéntico al manejador por defecto de express-rate-limit: onboarding no cambia.
    res.status(options.statusCode).send(options.message)
  },
})

/** MISMA instancia (mismo contador) que `limiteIntentosDeCodigo`, pero el 429 sale en JSON y en español: para `/public/alta/verificar`. */
export const limiteIntentosDeCodigoEnAlta: RequestHandler = (req, res, next) => {
  res.locals[RESPUESTA_EN_JSON] = true
  return limiteIntentosDeCodigo(req, res, next)
}

/**
 * Mandar códigos al correo de alguien: 3 por correo por hora (en desarrollo, 20).
 *
 * UNA sola instancia (y por tanto UN solo contador por correo) para `/onboarding/resend-verification`
 * y `/public/contact`. Su respuesta de siempre es texto plano; sólo si la petición viene marcada por
 * `limiteEnviosDeCodigoEnContacto` contesta el JSON en español de la landing.
 */
export const limiteEnviosDeCodigo = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDevelopment ? 20 : 3, // Dev: 20/hour, Prod: 3/hour
  message: 'Too many resend requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: llavePorCorreoOIp,
  handler: (_req, res, _next, options) => {
    if (res.locals[RESPUESTA_EN_JSON]) {
      res.status(options.statusCode).json({
        success: false,
        code: 'DEMASIADOS_ENVIOS',
        message: 'Ya te mandamos varios códigos. Espera unos minutos y revisa tu correo.',
      })
      return
    }
    // Idéntico al manejador por defecto de express-rate-limit: onboarding no cambia.
    res.status(options.statusCode).send(options.message)
  },
})

/**
 * El tope de envíos de código aplicado a `/public/contact`.
 *
 * 🔴 Sólo cuenta con el interruptor `ALTA_LANDING_CON_CODIGO` PRENDIDO: apagado, `/contact` no manda
 * ningún código y no debe gastar el presupuesto de nadie (el comportamiento es el de hoy). Prendido
 * usa la MISMA instancia que `/onboarding/resend-verification` (contador compartido por correo) y,
 * al topar, contesta JSON en español en vez del texto en inglés.
 */
export const limiteEnviosDeCodigoEnContacto: RequestHandler = (req, res, next) => {
  if (!altaLandingConCodigo()) return next()
  res.locals[RESPUESTA_EN_JSON] = true
  return limiteEnviosDeCodigo(req, res, next)
}

/**
 * `/public/contact`: los mismos 5 por minuto que el `writeLimit` compartido, pero por CORREO.
 *
 * 🔴 Por IP, el sexto prospecto del minuto recibía 429: la landing llama a este endpoint desde su
 * servidor, así que todos los visitantes llegan con la misma IP.
 */
export const limiteContactoPorCorreo = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: llavePorCorreoOIp,
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * `/public/contact`, techo POR IP: 120 por minuto, holgado a propósito.
 *
 * El tope fino es por correo (arriba); éste sólo corta a un solo origen que dispara el endpoint a
 * ráfagas con correos distintos. Detrás del proxy de la landing muchos visitantes comparten IP,
 * por eso es 24 veces el tope por correo y no 5.
 */
export const limiteContactoPorIp = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: req => ipDelCliente(req) || 'desconocida',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    res.status(options.statusCode).json({
      success: false,
      code: 'DEMASIADAS_SOLICITUDES',
      message: 'Demasiadas solicitudes desde tu red. Intenta de nuevo en un minuto.',
    })
  },
})
