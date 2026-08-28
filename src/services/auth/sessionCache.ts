// src/services/auth/sessionCache.ts
/**
 * Caché de "¿esta sesión sigue viva?" delante de `session.service.isSessionAlive` — el
 * middleware la pregunta en CADA petición, y consultar la base cada vez sería inaceptable en
 * el camino de cobro.
 *
 * Tres reglas duras (cada una con su prueba en `sessionCache.test.ts`):
 *
 * 1. Redis caído ⇒ se consulta la base. NUNCA se acepta por defecto. Un `catch` que
 *    devolviera `true` sería un agujero de seguridad: cualquiera con un token de una sesión
 *    revocada entraría tumbando Redis.
 * 2. Si Redis Y la base fallan, la petición FALLA — se propaga el error, nunca se inventa
 *    un `true`.
 * 3. La invalidación (`invalidateSession`, para quien llame a `session.service.revokeSession`
 *    o `revokeAllSessionsForStaff` — cablearla ahí es de otra tarea, ésta sólo la produce)
 *    escribe un TOMBSTONE, no un `DEL`. Con `DEL`, una lectura de "está viva" que empezó ANTES del
 *    commit puede volver a escribir "viva" justo después de borrarla, y la sesión revocada
 *    revive hasta que expire el TTL. El tombstone gana siempre: si el valor es `'revoked'`,
 *    se devuelve `false` sin tocar la base.
 */
import * as redis from './redisClient'
import { isSessionAlive } from './session.service'

const TTL_SEGUNDOS = 60
const llave = (id: string) => `sess:${id}`

export async function isSessionAliveCached(sessionId: string): Promise<boolean> {
  try {
    const v = await redis.get(llave(sessionId))
    if (v === 'revoked') return false // tombstone: gana siempre, ni la base se consulta
    if (v === 'alive') return true
  } catch {
    // Redis caído (o no configurado — REDIS_URL es opcional): se cae a la base.
    // NUNCA se acepta por defecto aquí.
  }
  const vivo = await isSessionAlive(sessionId) // si truena, propaga: falla cerrado (regla 2)
  try {
    await redis.setEx(llave(sessionId), vivo ? 'alive' : 'revoked', TTL_SEGUNDOS)
  } catch {
    // Cachear es best-effort: que Redis no reciba la escritura no puede tumbar la respuesta
    // que la base ya dio.
  }
  return vivo
}

/**
 * Se llama DESPUÉS del commit que revoca (ej. `session.service.revokeSession` /
 * `revokeAllSessionsForStaff`). Escribe tombstone, nunca borra — ver regla 3 arriba.
 * Cablear la llamada real desde el punto de revocación es trabajo de otra tarea del plan.
 */
export async function invalidateSession(sessionId: string): Promise<void> {
  try {
    await redis.setTombstone(llave(sessionId), TTL_SEGUNDOS)
  } catch {
    // Best-effort: si Redis no recibe el tombstone, el peor caso es que esa sesión
    // revocada tarde hasta TTL_SEGUNDOS en dejar de aceptarse desde OTRA instancia con
    // caché tibia — nunca que la petición actual falle por esto.
  }
}
