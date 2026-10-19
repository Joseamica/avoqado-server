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
