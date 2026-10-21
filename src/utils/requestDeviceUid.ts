import type { Request } from 'express'

/**
 * El `X-Device-ID` del aparato, leído de UNA forma: el primero si llega repetido, sin espacios, a lo más 64 caracteres;
 * `null` si no viene. Lo comparten `/settings`, el poll de la pantalla del cliente y `/promotions` para que el mismo
 * aparato nunca se identifique distinto en dos rutas.
 */
export function requestDeviceUid(req: Request): string | null {
  const raw = req.headers?.['x-device-id']
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = typeof value === 'string' ? value.trim().slice(0, 64) : ''
  return trimmed || null
}
