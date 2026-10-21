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
 * 🔴 MEDIDO EN PRODUCCIÓN el 2026-10-21: `CF-Connecting-IP` NO se puede inventar, ni por
 * `api.avoqado.io` ni por `avoqado-server.onrender.com`. Las dos puertas pasan por el MISMO borde: el
 * Cloudflare de Render (`onrender.com` responde `server: cloudflare` + `cf-ray`, y `api.avoqado.io` es
 * un CNAME hacia él). Una petición que trae su propio `CF-Connecting-IP` la corta Cloudflare con el
 * error 1000 antes de llegar aquí, y desde un Worker ajeno el valor queda fijo en `2a06:98c0:3600::103`.
 * Detalle y la medición: `docs/audit/2026-10-21-limites-por-ip/` del workspace.
 *
 * 🔴 `X-Forwarded-For` en cambio SÍ llega como lo escribió el visitante: Cloudflare y el proxy de
 * Render AGREGAN su eslabón al final, no reemplazan la cadena. Por eso su PRIMER eslabón no se usa
 * nunca: sin `CF-Connecting-IP` (petición que no pasó por Cloudflare) la llave es `req.ip`, que es el
 * eslabón que puso el proxy de Render y nadie de afuera escribe.
 *
 * Contra el abuso lo que aguanta no es la IP sino la verificación por correo y la tarjeta de Stripe —
 * por eso los limitadores de este carril llavean por CORREO y dejan la IP como respaldo.
 *
 * Hermano de `resolveClientIp` en `heartbeat.tpv.controller.ts`, que documentó lo mismo para las
 * terminales. Si algún día se unifican, que sea aquí.
 */
import { Request } from 'express'

export function ipDelCliente(req: Request): string | undefined {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()

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
