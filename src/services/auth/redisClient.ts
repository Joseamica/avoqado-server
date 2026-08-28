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
 * sólo complicaría esta pieza sin cambiar el comportamiento observable.
 */
import { createClient, RedisClientType } from 'redis'
import { REDIS_URL } from '../../config/env'
import logger from '../../config/logger'

let client: RedisClientType | null = null
let connecting: Promise<RedisClientType> | null = null

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
    const instance = createClient({ url: REDIS_URL }) as RedisClientType
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
        return instance
      })
      .catch(err => {
        client = null
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

export async function setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
  const c = await getClient()
  await c.setEx(key, ttlSeconds, value)
}

/**
 * Tombstone: mismo mecanismo que `setEx`, valor fijo `'revoked'`. `sessionCache.ts` lo lee
 * como "gana siempre" — nunca se le pregunta nada más una vez visto.
 */
export async function setTombstone(key: string, ttlSeconds: number): Promise<void> {
  await setEx(key, 'revoked', ttlSeconds)
}
