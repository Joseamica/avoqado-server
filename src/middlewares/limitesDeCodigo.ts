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
import rateLimit from 'express-rate-limit'
import { llavePorCorreoOIp } from '../utils/clientIp'

// Más permisivo en desarrollo para poder probar a mano.
const isDevelopment = process.env.NODE_ENV !== 'production'

/** Adivinar el código: 5 intentos por correo cada 15 minutos (en desarrollo, 50). */
export const limiteIntentosDeCodigo = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 50 : 5, // Dev: 50/15min, Prod: 5/15min
  message: 'Too many verification attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: llavePorCorreoOIp,
})

/** Mandar códigos al correo de alguien: 3 por correo por hora (en desarrollo, 20). */
export const limiteEnviosDeCodigo = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDevelopment ? 20 : 3, // Dev: 20/hour, Prod: 3/hour
  message: 'Too many resend requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: llavePorCorreoOIp,
})

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
