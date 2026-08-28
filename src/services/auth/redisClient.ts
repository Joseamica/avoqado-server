// src/services/auth/redisClient.ts
/**
 * Envoltorio delgado sobre el paquete `redis` (v5, ya en `package.json`), sólo para
 * `sessionCache.ts`. Expone `get`, `setEx` y `setTombstone` — nada más.
 *
 * ── Por qué NO reusa el cliente de `socketManager.ts` ──────────────────────────────
 * Ese cliente es un campo PRIVADO de `SocketManager`, sólo se crea si
 * `SocketServerConfig.redis` viene poblado, y sirve al adapter pub/sub de Socket.IO — un
 * propósito distinto a comandos simples GET/SETEX. No hay ningún cliente Redis compartido
 * y exportado en el repo hoy; este módulo es su propio cliente perezoso, sobre la MISMA
 * variable `REDIS_URL` (`src/config/env.ts:47`).
 *
 * ── `REDIS_URL` es OPCIONAL ─────────────────────────────────────────────────────────
 * Sin ella, este módulo nunca conecta y sus tres funciones RECHAZAN con un error claro.
 * Eso es intencional, no un descuido: para quien llama (`sessionCache.ts`), "no configurado"
 * y "caído" son la misma cosa — "no puedo cachear ahora mismo" — y `sessionCache.ts` YA
 * trata cualquier rechazo de `get`/`setEx`/`setTombstone` como "cae a la base" / "cachear es
 * best-effort". No hace falta un segundo camino para "no configurado": tratarlo distinto
 * sólo complicaría esta pieza sin cambiar el comportamiento observable. (Diferido a propósito
 * — hallazgo Menor de la ronda de revisión de Task 4: usar una excepción como control de
 * flujo para "no configurado" es mejorable, pero no es gratis arreglarlo aquí y no toca la
 * seguridad — se deja para cuando alguien lo pida explícitamente.)
 *
 * ── Dos arreglos de la ronda de revisión de Task 4 ─────────────────────────────────
 *
 * 1. [Crítico] `setEx` YA NO es un SETEX plano. Un cache-fill de 'alive' que arrancó ANTES
 *    de una revocación puede resolver DESPUÉS de que `setTombstone` ya escribió 'revoked' —
 *    y un SETEX plano lo pisaría, dejando la sesión revocada "viva" en caché hasta el TTL.
 *    `setEx` ahora corre un script Lua (`EVAL`) que compara-y-escribe DENTRO de Redis: "si
 *    el valor actual es 'revoked', no toques nada". Un compara-y-luego-escribe hecho desde
 *    Node (GET, decidir, y SETEX como dos viajes de red separados) tiene la MISMA carrera
 *    que esto arregla — el GET de una llamada y el SETEX de otra se pueden entrelazar.
 *    Dentro de un script Lua, Redis ejecuta el script COMPLETO como una unidad indivisible:
 *    ninguna otra orden, de ningún cliente, puede correr a la mitad. Ver `LUA_SET_UNLESS_REVOKED`.
 * 2. [Importante] `getClient()` ya NO crea un `createClient()` nuevo en cada petición
 *    mientras Redis está CAÍDO (a diferencia de "no configurado" — ese caso es barato, nunca
 *    abre un socket, y no necesita cooldown). Un cooldown (`BACKOFF_MS`) recuerda la última
 *    falla y, mientras esté vigente, rechaza de inmediato sin abrir un socket nuevo ni volver
 *    a registrar un `warn`. `reconnectStrategy: false` apaga el reintento automático interno
 *    del cliente `redis` para que este cooldown sea la ÚNICA fuente de reintentos — dos
 *    mecanismos de retry corriendo en paralelo (el interno de la librería + el nuestro) sería
 *    una tormenta de reconexión, no resiliencia.
 */
import { createClient, RedisClientType } from 'redis'
import { REDIS_URL } from '../../config/env'
import logger from '../../config/logger'

let client: RedisClientType | null = null
let connecting: Promise<RedisClientType> | null = null
let lastFailureAt = 0

/**
 * Ventana mínima entre dos intentos de conexión tras una falla real (Redis inalcanzable).
 * Bajo carga sostenida de caída, sin esto CADA petición autenticada abriría un socket nuevo
 * y perdería tiempo intentando conectar antes de caer a la base — en el camino más caliente
 * del servidor. 5 s corta ese desperdicio a un intento cada 5 s, y sigue siendo lo bastante
 * corto para recuperarse rápido en cuanto Redis vuelve.
 */
const BACKOFF_MS = 5000

/**
 * Devuelve un cliente conectado, o rechaza. Nunca deja un cliente a medio conectar en
 * `client` — sólo se asigna tras `.connect()` resuelto, así que una conexión fallida no
 * deja basura para el siguiente intento.
 */
async function getClient(): Promise<RedisClientType> {
  if (!REDIS_URL) {
    throw new Error('REDIS_URL no está configurada — sessionCache no puede usar Redis')
  }
  if (client?.isOpen) {
    return client
  }
  if (!connecting) {
    const sinceFailure = Date.now() - lastFailureAt
    if (lastFailureAt !== 0 && sinceFailure < BACKOFF_MS) {
      // En cooldown: NO se crea un cliente nuevo ni se abre un socket. Ver hallazgo
      // [Importante] arriba — esto es lo que corta la tormenta de reconexión.
      throw new Error(`redisClient: en cooldown tras una falla de conexión hace ${sinceFailure}ms — se reintenta pasados ${BACKOFF_MS}ms`)
    }
    const instance = createClient({
      url: REDIS_URL,
      // Nuestro cooldown es la ÚNICA fuente de reintentos — ver hallazgo [Importante] arriba.
      socket: { reconnectStrategy: false },
    }) as RedisClientType
    // Sin este listener, un error de socket post-conexión (ej. el servidor Redis se cae
    // a media vida del proceso) sube como excepción no capturada y tumba el proceso entero
    // — justo lo que "degradar, nunca bloquear" prohíbe. Sólo se registra: quien de verdad
    // decide qué pasa con la sesión es `sessionCache.ts`, no este archivo.
    instance.on('error', err => {
      logger.warn('redisClient (sessionCache): error de conexión', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    connecting = instance
      .connect()
      .then(() => {
        client = instance
        lastFailureAt = 0
        return instance
      })
      .catch(err => {
        client = null
        lastFailureAt = Date.now()
        throw err
      })
      .finally(() => {
        connecting = null
      })
  }
  return connecting
}

export async function get(key: string): Promise<string | null> {
  const c = await getClient()
  return c.get(key)
}

/**
 * Script Lua del arreglo [Crítico] — ver docblock del módulo. `KEYS[1]` = la llave;
 * `ARGV[1]` = el valor a escribir; `ARGV[2]` = el TTL en segundos. Corre COMPLETO como una
 * sola unidad indivisible dentro de Redis: ninguna otra orden puede intercalarse a la mitad,
 * así que no importa en qué orden dos llamadas concurrentes LLEGUEN — sólo importa cuál
 * EJECUTA primero, y ésa gana de verdad.
 */
const LUA_SET_UNLESS_REVOKED = `
if redis.call('GET', KEYS[1]) == 'revoked' then
  return 0
end
redis.call('SETEX', KEYS[1], ARGV[2], ARGV[1])
return 1
`

/**
 * Escribe `value` con TTL `ttlSeconds`, salvo que el valor actual ya sea `'revoked'` — en
 * ese caso no toca nada. Es la mitad "cache-fill" de `sessionCache.ts` (puede llegar con
 * 'alive' o con 'revoked' según lo que diga la base) y las DOS deben respetar un tombstone
 * ya escrito, así que el guard no distingue el valor entrante.
 */
export async function setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
  const c = await getClient()
  await c.eval(LUA_SET_UNLESS_REVOKED, { keys: [key], arguments: [value, String(ttlSeconds)] })
}

/**
 * Tombstone: SIEMPRE toma efecto, incluso si el valor actual ya era `'revoked'` (revocar dos
 * veces no es un error — mismo espíritu que `session.service.revokeSession`). Por eso llama
 * al `setEx` RAW del cliente, no al `setEx` exportado arriba: ese guard existe para proteger
 * al tombstone de un 'alive' tardío, no al revés — el tombstone nunca necesita protegerse de
 * sí mismo.
 */
export async function setTombstone(key: string, ttlSeconds: number): Promise<void> {
  const c = await getClient()
  await c.setEx(key, ttlSeconds, 'revoked')
}
