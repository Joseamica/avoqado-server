/**
 * Quién es el visitante, cuando el servidor sólo ve a Cloudflare.
 *
 * 🔴 MEDIDO EN PRODUCCIÓN el 2026-09-17: el **100 %** de las ~22 000 IPs que el servidor registró
 * en 24 h son direcciones de **Cloudflare** (`172.64–172.71.x`, `162.158–162.159.x`,
 * `104.22–104.23.x`, `198.41.227.x`). Ni una de un cliente real. La más cargada atendió 4 346
 * peticiones ella sola.
 *
 * La causa: la cadena es `cliente → borde de Cloudflare → proxy de Render → app`, o sea **dos**
 * saltos, y `app.set('trust proxy', 1)` (`src/config/middleware.ts`) desenvuelve **uno**. Lo que
 * queda en `req.ip` es el borde, compartido por todos los visitantes de esa región.
 *
 * Consecuencia para un limitador: «3 altas por hora por IP» no son 3 por PERSONA sino 3 por BORDE.
 * Con anuncios encendidos, el cuarto interesado de la hora lee «Too many signup attempts from this
 * IP» — y parece que el anuncio convierte mal.
 *
 * 🔴 NO se arregla subiendo `trust proxy` a 2: eso es global y cambiaría también el registro, la
 * sesión y todos los demás limitadores. Se resuelve aquí, acotado a quien lo necesita.
 *
 * ⚠️ Límite declarado: `CF-Connecting-IP` es falsificable por quien alcance el origen de Render sin
 * pasar por el borde (`avoqado-server.onrender.com` es alcanzable). Aun así el saldo es favorable:
 * hoy la llave es UNA sola para todo México y bloquea a clientes buenos. Contra el abuso real lo que
 * aguanta no es la IP sino la verificación por correo y la tarjeta de Stripe — por eso los
 * limitadores de este carril llavean por CORREO y dejan la IP como respaldo.
 *
 * Hermano de `resolveClientIp` en `heartbeat.tpv.controller.ts`, que documentó lo mismo para las
 * terminales. Si algún día se unifican, que sea aquí.
 */
import { Request } from 'express'

export function ipDelCliente(req: Request): string | undefined {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()

  const xff = req.headers['x-forwarded-for']
  const cadena = Array.isArray(xff) ? xff[0] : xff
  const primero = cadena?.split(',')[0]?.trim()
  if (primero) return primero

  return req.ip
}

/**
 * La llave de un limitador de este carril: el CORREO manda y la IP real es el respaldo.
 *
 * 🔴 El correo primero no es un detalle: es lo único que identifica a una PERSONA. La IP —aunque se
 * resuelva bien— sigue siendo compartida por una oficina, un café o una red móvil entera.
 */
export function llavePorCorreoOIp(req: Request): string {
  const correo = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  return correo || ipDelCliente(req) || 'desconocida'
}
