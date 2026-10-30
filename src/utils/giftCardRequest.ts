/**
 * Tarjetas de regalo — lo que las rutas sacan de la petición: quién (`Staff.id` del token, nunca `StaffVenue.id`), desde
 * qué aparato (`X-Device-Id`, el encabezado que ya mandan el POS y la TPV) y desde dónde (IP y agente, para la bitácora).
 */
import type { Request } from 'express'
import { UnauthorizedError } from '@/errors/AppError'

export function staffDe(req: Request): string {
  const id = (req as any).authContext?.userId
  if (typeof id !== 'string' || !id) throw new UnauthorizedError('Autenticación requerida')
  return id
}

export function aparatoDe(req: Request): string | null {
  const raw = req.headers['x-device-id']
  const valor = Array.isArray(raw) ? raw[0] : raw
  return typeof valor === 'string' && valor.trim() ? valor.trim().slice(0, 64) : null
}

export function origenDe(req: Request): { ipAddress?: string; userAgent?: string } {
  return { ipAddress: req.ip, userAgent: req.get('user-agent') ?? undefined }
}

/**
 * Q110: quién EMPEZÓ la operación según el aparato (el reenvío de otra sesión). `{ iniciadoPorSegunElAparato: { iniciadoPor,
 * iniciadoPorNombre } }` si el cuerpo trae `iniciadoPor` distinto de `staffDe(req)`; si no, `{}`. Sólo para el `data` de la
 * bitácora: nunca autor, ni comisión, ni huella. El servidor no lo valida contra nada (es lo que dice el aparato).
 */
export function segunElAparato(req: Request): Record<string, unknown> {
  const { iniciadoPor, iniciadoPorNombre } = (req.body ?? {}) as { iniciadoPor?: unknown; iniciadoPorNombre?: unknown }
  if (typeof iniciadoPor !== 'string' || !iniciadoPor || iniciadoPor === staffDe(req)) return {}
  return {
    iniciadoPorSegunElAparato: { iniciadoPor, iniciadoPorNombre: typeof iniciadoPorNombre === 'string' ? iniciadoPorNombre : null },
  }
}
