// src/middlewares/registerDevice.middleware.ts

/**
 * Registro pasivo de dispositivos — se monta UNA VEZ con `router.use()` al inicio de
 * `mobile.routes.ts`.
 *
 * Cada request autenticado de un POS trae headers `X-Device-*`. Este middleware los lee
 * y refresca (o crea) el `Terminal` correspondiente, para que el dueño vea en el
 * dashboard qué aparatos están operando en su venue. Es el equivalente de
 * "every device signed into the Point of Sale app" del Device Management de Square.
 *
 * ── Por qué se engancha a `res.on('finish')` y no corre en línea ──────────────────
 *
 * En `mobile.routes.ts` la autenticación es POR RUTA (126 llamadas a
 * `authenticateTokenMiddleware`), no hay `router.use` global. Un `router.use` arriba
 * correría ANTES de autenticar y `authContext` no existiría todavía; y meter esto en
 * las 126 rutas sería absurdo y frágil.
 *
 * Enganchado a `finish` resuelve las dos cosas: corre cuando la respuesta YA salió, con
 * `authContext` poblado por la ruta que sí autenticó, desde un solo punto de montaje.
 * De paso queda estructuralmente imposible que afecte el request: cero latencia, y no
 * puede alterar códigos de estado ni cuerpos.
 *
 * ── Tres cosas que definen este archivo ───────────────────────────────────────────
 *
 * 1. JAMÁS BLOQUEA. Esto cuelga del camino del cobro. Llama a `next()` de inmediato y
 *    todo el trabajo ocurre después de la respuesta. Si algo falla, falla solo y en
 *    silencio (el servicio ya nunca lanza). Un dispositivo que tarda en aparecer en una
 *    lista es infinitamente mejor que un cobro que no pasa.
 *
 * 2. DEBOUNCE OBLIGATORIO. Sin él, un upsert por request. Ya hay precedente doloroso:
 *    el flush de `tpv:heartbeat` al reconectar agotó el pool de conexiones. El caché
 *    es EN PROCESO a propósito, no en Redis: `REDIS_URL` es OPCIONAL en este repo
 *    (`src/config/env.ts`) y meter una dependencia dura de Redis en el camino del cobro
 *    contradice la regla de "degradar, nunca bloquear".
 *    Costo honesto: con N instancias del server son hasta N escrituras por ventana en
 *    vez de 1 global. Sigue siendo >98% menos que escribir por request.
 *
 * 3. LOS HEADERS SON ENTRADA NO CONFIABLE. Cualquiera con un token válido puede mandar
 *    lo que quiera. Todo se recorta a un largo máximo y los valores de enum se validan
 *    contra el enum real — nunca se pasa un string crudo del cliente a Prisma.
 */

import { NextFunction, Request, Response } from 'express'
import { DeviceFormFactor } from '@prisma/client'

import logger from '../config/logger'
import { DevicePlatformHeader, registerDeviceSeen } from '../services/mobile/deviceRegistry.service'

/** Ventana del debounce. Un dispositivo se escribe a lo más una vez por ventana. */
const SEEN_TTL_MS = 60_000

/**
 * Tope de entradas del caché. Un venue grande con 50 aparatos usa 50 renglones; el tope
 * está muy por encima de cualquier operación real y sólo existe para que un cliente
 * mandando deviceUids basura no infle la memoria del proceso sin límite.
 */
const MAX_CACHE_ENTRIES = 10_000

/** Largos máximos. Recortar, no rechazar: el registro nunca debe romper un request. */
const MAX_UID_LEN = 64 // = PosSyncIntent.deviceId VarChar(64)
const MAX_TEXT_LEN = 120

/** `deviceUid` de venue → epoch ms en que expira su entrada. */
const seenCache = new Map<string, number>()

/** Quita lo expirado; si aún rebasa el tope, tira lo más viejo. */
function pruneCache(now: number): void {
  for (const [key, expiry] of seenCache) {
    if (expiry <= now) seenCache.delete(key)
  }
  if (seenCache.size <= MAX_CACHE_ENTRIES) return

  // Map preserva orden de inserción: los primeros son los más viejos.
  const excess = seenCache.size - MAX_CACHE_ENTRIES
  let removed = 0
  for (const key of seenCache.keys()) {
    seenCache.delete(key)
    if (++removed >= excess) break
  }
}

/**
 * ¿Toca escribir? Marca la ventana y devuelve true sólo la primera vez dentro de ella.
 */
function shouldWrite(cacheKey: string, now: number): boolean {
  const expiry = seenCache.get(cacheKey)
  if (expiry !== undefined && expiry > now) return false

  seenCache.set(cacheKey, now + SEEN_TTL_MS)
  if (seenCache.size > MAX_CACHE_ENTRIES) pruneCache(now)
  return true
}

/** Sólo para tests: deja el caché limpio entre casos. */
export function __resetDeviceSeenCache(): void {
  seenCache.clear()
}

function readHeader(req: Request, name: string, maxLen = MAX_TEXT_LEN): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLen) : undefined
}

const VALID_PLATFORMS: readonly DevicePlatformHeader[] = ['IOS', 'ANDROID', 'DESKTOP']

/** Valida contra los valores reales del enum. Un valor inventado se ignora, no truena. */
function parseFormFactor(value: string | undefined): DeviceFormFactor | undefined {
  if (!value) return undefined
  const upper = value.toUpperCase()
  return (Object.values(DeviceFormFactor) as string[]).includes(upper) ? (upper as DeviceFormFactor) : undefined
}

function parsePlatform(value: string | undefined): DevicePlatformHeader | undefined {
  if (!value) return undefined
  const upper = value.toUpperCase() as DevicePlatformHeader
  return VALID_PLATFORMS.includes(upper) ? upper : undefined
}

/**
 * Hace el registro. Se llama cuando la respuesta ya se envió.
 * Nunca lanza: cualquier error se traga y se registra.
 */
function registerFromRequest(req: Request): void {
  try {
    const deviceUid = readHeader(req, 'x-device-id', MAX_UID_LEN)
    if (!deviceUid) return // apps viejas que aún no mandan el header: sin cambios

    const platform = parsePlatform(readHeader(req, 'x-device-platform'))
    if (!platform) return // sin plataforma no sabemos qué tipo de terminal es

    // `authContext` lo pobló la ruta que autenticó. En endpoints públicos (login) no
    // existe todavía; el dispositivo se registra en el primer request autenticado, que
    // la app hace de inmediato al entrar.
    const auth = (req as any).authContext
    const venueId: string | undefined = auth?.venueId
    const staffId: string | undefined = auth?.userId
    if (!venueId || !staffId) return

    // El debounce se evalúa AQUÍ y no al entrar: si marcáramos la ventana antes de
    // saber si hay authContext, un endpoint público quemaría el turno del dispositivo
    // y retrasaría su registro real hasta 60s.
    if (!shouldWrite(`${venueId}:${deviceUid}`, Date.now())) return

    // `registerDeviceSeen` está escrito para no lanzar nunca, pero el .catch queda como
    // cinturón: una promesa rechazada sin manejar tumbaría el proceso en Node.
    void registerDeviceSeen({
      venueId,
      staffId,
      identity: {
        deviceUid,
        platform,
        manufacturer: readHeader(req, 'x-device-manufacturer'),
        modelIdentifier: readHeader(req, 'x-device-model'),
        formFactor: parseFormFactor(readHeader(req, 'x-device-form-factor')),
        osVersion: readHeader(req, 'x-device-os-version'),
        appVersion: readHeader(req, 'x-app-version'),
        serialNumber: readHeader(req, 'x-device-serial'),
      },
    }).catch(error => {
      logger.error('[DEVICE REGISTRY] Error no esperado en registro de dispositivo (no bloqueante)', error)
    })
  } catch (error) {
    // Un bug en el parseo de headers no puede afectar nada: aquí la respuesta ya salió.
    logger.error('[DEVICE REGISTRY] Falló el registro de dispositivo (no bloqueante)', error)
  }
}

/**
 * Middleware. Sólo engancha el trabajo al final de la respuesta y sigue de inmediato.
 */
export function registerDeviceMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    res.on('finish', () => registerFromRequest(req))
  } catch (error) {
    logger.error('[DEVICE REGISTRY] No se pudo enganchar el registro de dispositivo (no bloqueante)', error)
  }
  return next()
}

export default registerDeviceMiddleware
