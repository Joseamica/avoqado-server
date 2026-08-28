// src/services/auth/sessionCache.ts
/**
 * Caché de "¿esta sesión sigue viva?" delante de `session.service.isSessionAlive` — el
 * middleware la pregunta en CADA petición, y consultar la base cada vez sería inaceptable en
 * el camino de cobro.
 *
 * ── Por qué es un `Map` en memoria del proceso, y no Redis ─────────────────────────────────
 * Este módulo nació sobre Redis (pensando en 2+ instancias), pero `.claude/rules/una-sola-
 * instancia.md` es explícito: prod corre UNA sola instancia A PROPÓSITO, con estado en la
 * memoria del proceso por diseño (sockets, rate limiters, crons). `REDIS_URL` ni siquiera
 * está configurada. Con una sola instancia, un `Map` local hace exactamente lo mismo que
 * hacía Redis para este caso — cachear delante de la base — sin la dependencia externa, sin
 * un viaje de red por lectura, y sin el modo "caído" que Redis sí podía tener (un `Map` no se
 * desconecta). Si el día de mañana el server sube a 2+ instancias, ese mismo archivo de
 * reglas ya documenta que esta caché necesita volver a ser compartida (punto 6) — no es este
 * módulo el que decide cuándo pasa eso.
 *
 * Tres reglas duras (cada una con su prueba en `sessionCache.test.ts`):
 *
 * 1. Cache miss (nunca escrita, o vencida) ⇒ se consulta la base. Si la base truena, el
 *    error se propaga — NUNCA se acepta por defecto. Un `catch` que devolviera `true` sería
 *    un agujero de seguridad: cualquiera con un token de una sesión revocada entraría en
 *    cuanto la base fallara.
 * 2. El tombstone gana. `invalidateSession` escribe un TOMBSTONE, nunca borra la llave. Con
 *    un `DEL` (o dejando que un cache-fill lo pise sin más), una lectura de "¿sigue viva?"
 *    que arrancó ANTES de la revocación puede resolver DESPUÉS de que ya se invalidó, y
 *    escribiría "viva" encima del tombstone — la sesión revocada reviviría hasta que expire
 *    el TTL. En JavaScript el `await` de la consulta a la base sí permite ese entrelazado
 *    (es el único punto donde otra operación corre en medio), así que la protección sigue
 *    haciendo falta aunque todo viva en un solo proceso: lo que desaparece es la necesidad
 *    de un script Lua (CAS atómico dentro de Redis) — aquí basta una comparación antes de
 *    escribir, porque Node es de un solo hilo y esa comparación-y-escritura no tiene forma de
 *    partirse a la mitad.
 * 3. La entrada caduca a los 60 s (`TTL_MS`), tanto si dice "viva" como si dice "revoked" —
 *    igual que el `EXPIRE` que Redis aplicaba a ambas. Pasado el TTL, la llave se trata como
 *    si nunca hubiera existido: se vuelve a consultar la base, y un tombstone viejo no puede
 *    bloquear un cache-fill para siempre.
 *
 * ── Fuga de memoria ──────────────────────────────────────────────────────────────────────
 * Un `Map` que sólo crece es una fuga. Se purga con el MISMO patrón que ya usa
 * `passwordChangeGuard.ts` para su propia caché en memoria (mismo archivo, mismo dominio):
 * nada de `setInterval` — un barrido perezoso que sólo corre cuando el tamaño ya cruzó un
 * umbral, disparado por una escritura. Se prefirió sobre un `setInterval` de módulo por dos
 * razones: no deja un timer vivo compitiendo con `detectOpenHandles`/`forceExit` de Jest, y
 * no gasta CPU en un servidor con la caché fría (sin sesiones activas, nunca barre nada).
 */
import { isSessionAlive } from './session.service'

const TTL_MS = 60_000 // 60 s
const UMBRAL_BARRIDO = 5_000

type EstadoSesion = 'alive' | 'revoked'

interface Entrada {
  estado: EstadoSesion
  expiraEn: number // Date.now() + TTL_MS al momento de escribirse
}

const cache = new Map<string, Entrada>()

function vigente(entrada: Entrada | undefined, ahora: number): entrada is Entrada {
  return entrada !== undefined && entrada.expiraEn > ahora
}

/**
 * Escribe el resultado de un cache-fill (lo que acaba de decir la base), salvo que — mientras
 * esa consulta estaba en vuelo — ya haya llegado un tombstone vigente. Ver regla 2 arriba.
 * No importa qué tan "fresco" sea el dato que trae `estado`: un tombstone vigente SIEMPRE
 * gana, exactamente como hacía el script Lua contra Redis.
 */
function escribirCacheFill(sessionId: string, estado: EstadoSesion, ahora: number): void {
  const actual = cache.get(sessionId)
  if (actual && actual.estado === 'revoked' && actual.expiraEn > ahora) {
    return // tombstone vigente: no se pisa, sin importar lo que diga la base
  }
  cache.set(sessionId, { estado, expiraEn: ahora + TTL_MS })
}

/** Sólo corre si la caché ya cruzó el umbral — ver "Fuga de memoria" arriba. */
function purgarSiHaceFalta(ahora: number): void {
  if (cache.size <= UMBRAL_BARRIDO) return
  for (const [id, entrada] of cache) {
    if (entrada.expiraEn <= ahora) cache.delete(id)
  }
}

export async function isSessionAliveCached(sessionId: string): Promise<boolean> {
  const ahora = Date.now()
  const entrada = cache.get(sessionId)

  if (vigente(entrada, ahora)) {
    return entrada.estado === 'alive'
  }

  // Cache miss (nunca escrita, o vencida): se pregunta a la base. Si truena, se propaga —
  // regla 1, nunca se acepta por defecto.
  const vivo = await isSessionAlive(sessionId)

  escribirCacheFill(sessionId, vivo ? 'alive' : 'revoked', Date.now())
  purgarSiHaceFalta(Date.now())

  return vivo
}

/**
 * Se llama DESPUÉS del commit que revoca (ej. `session.service.revokeSession` /
 * `revokeAllSessionsForStaff`). Escribe tombstone, nunca borra — ver regla 2 arriba.
 * A diferencia de la versión sobre Redis, no hace falta un try/catch best-effort: un `Map`
 * local no tiene un modo "caído" que proteger — la única forma de que esto truene es un
 * error de programación, y ése SÍ debe propagarse, no tragarse en silencio.
 */
export async function invalidateSession(sessionId: string): Promise<void> {
  const ahora = Date.now()
  cache.set(sessionId, { estado: 'revoked', expiraEn: ahora + TTL_MS })
  purgarSiHaceFalta(ahora)
}

/** Sólo para tests: deja la caché como recién arrancada. */
export function _limpiarCacheDeSesiones(): void {
  cache.clear()
}

/** Sólo para tests: cuántas llaves hay ahora mismo (vigentes o no barridas todavía). */
export function _tamanoCacheDeSesiones(): number {
  return cache.size
}
