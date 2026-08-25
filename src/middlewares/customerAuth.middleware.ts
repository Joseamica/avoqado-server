/**
 * Customer Authentication Middleware — identidad del cliente atada al venue.
 *
 * Fase 0.B del kiosco de reservas (`FASE-0-fundacion-design.md` v5). Antes de esto un JWT
 * válido de venue A pasaba como "autenticado" en venue B y la reserva de clase re-ligaba por
 * el email tecleado. Ahora la regla es una sola:
 *
 *   🔴 Cualquier `Authorization` PRESENTE se valida; nunca se degrada a invitado.
 *
 * Dos variantes, mismo contrato de errores:
 *   - `authenticateCustomer`          → sin header ⇒ 401 CUSTOMER_AUTH_REQUIRED
 *   - `authenticateCustomerOptional`  → sin header ⇒ req.customerAuth = null, sigue como invitado
 *
 *   header sin "Bearer " / vacío              → 401 CUSTOMER_TOKEN_INVALID
 *   firma inválida / expirado / type≠customer → 401 CUSTOMER_TOKEN_INVALID
 *   payload.venueId ≠ venue de la URL         → 401 CUSTOMER_TOKEN_VENUE_MISMATCH (sin tocar DB)
 *   Customer {id, venueId} no existe          → 401 CUSTOMER_TOKEN_INVALID (no revelar que existió)
 *   Customer.active = false                   → 401 CUSTOMER_INACTIVE
 *
 * Depende de que `req.publicVenue` venga ya resuelto por `resolveVenueBySlug` — el venue de
 * la URL manda, no el del token. Si falta, es una ruta mal cableada: 500, nunca dejar pasar.
 */

import { Request, Response, NextFunction } from 'express'
import { verifyCustomerToken } from '../jwt.service'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'

export interface CustomerAuthContext {
  customerId: string
  venueId: string
}

export interface PublicVenueContext {
  id: string
  slug: string
}

type AuthFailure = {
  status: 401
  code: 'CUSTOMER_AUTH_REQUIRED' | 'CUSTOMER_TOKEN_INVALID' | 'CUSTOMER_TOKEN_VENUE_MISMATCH' | 'CUSTOMER_INACTIVE'
  message: string
}

const FAIL: Record<AuthFailure['code'], AuthFailure> = {
  CUSTOMER_AUTH_REQUIRED: { status: 401, code: 'CUSTOMER_AUTH_REQUIRED', message: 'Se requiere autenticación' },
  CUSTOMER_TOKEN_INVALID: { status: 401, code: 'CUSTOMER_TOKEN_INVALID', message: 'Token inválido o expirado' },
  CUSTOMER_TOKEN_VENUE_MISMATCH: {
    status: 401,
    code: 'CUSTOMER_TOKEN_VENUE_MISMATCH',
    message: 'Tu sesión pertenece a otro negocio. Inicia sesión de nuevo.',
  },
  CUSTOMER_INACTIVE: { status: 401, code: 'CUSTOMER_INACTIVE', message: 'Esta cuenta está desactivada' },
}

/**
 * Resuelve la identidad a partir del header. Devuelve el contexto, `null` si no hay
 * header (el caller decide si eso es invitado o 401), o un fallo tipado.
 */
async function resolveCustomerAuth(
  req: Request,
): Promise<{ ok: true; auth: CustomerAuthContext | null } | { ok: false; failure: AuthFailure }> {
  const authHeader = req.headers.authorization
  // Sólo la AUSENCIA del header es invitado. Un header presente pero vacío (`Authorization: `)
  // es un cliente mal configurado, no un invitado: se rechaza como cualquier token inválido.
  if (authHeader === undefined) {
    return { ok: true, auth: null }
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_INVALID }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_INVALID }
  }

  let payload: { sub: string; venueId: string }
  try {
    payload = verifyCustomerToken(token)
  } catch {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_INVALID }
  }

  const venue = (req as any).publicVenue as PublicVenueContext | undefined
  if (!venue?.id) {
    // Ruta mal cableada: el middleware corre antes de resolver el venue. No es culpa del
    // cliente y no se puede decidir nada con seguridad.
    throw new Error('authenticateCustomer: req.publicVenue no está resuelto (falta resolveVenueBySlug)')
  }

  // El venue de la URL manda. Se decide ANTES de tocar la DB: un token ajeno no gasta una query.
  if (payload.venueId !== venue.id) {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_VENUE_MISMATCH }
  }

  const customer = await prisma.customer.findFirst({
    where: { id: payload.sub, venueId: venue.id },
    select: { id: true, venueId: true, active: true },
  })
  if (!customer) {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_INVALID }
  }
  if (!customer.active) {
    return { ok: false, failure: FAIL.CUSTOMER_INACTIVE }
  }

  return { ok: true, auth: { customerId: customer.id, venueId: customer.venueId } }
}

function reply(res: Response, failure: AuthFailure) {
  return res.status(failure.status).json({ message: failure.message, code: failure.code })
}

async function run(req: Request, res: Response, next: NextFunction, required: boolean) {
  let result: Awaited<ReturnType<typeof resolveCustomerAuth>>
  try {
    result = await resolveCustomerAuth(req)
  } catch (err) {
    logger.error('customerAuth: fallo interno', { error: (err as Error).message })
    return res.status(500).json({ message: 'Error interno de autenticación', code: 'CUSTOMER_AUTH_INTERNAL' })
  }

  if (!result.ok) {
    return reply(res, result.failure)
  }

  if (result.auth === null) {
    if (required) {
      return reply(res, FAIL.CUSTOMER_AUTH_REQUIRED)
    }
    ;(req as any).customerAuth = null
    return next()
  }

  ;(req as any).customerAuth = result.auth
  return next()
}

/** Sesión de cliente obligatoria. */
export function authenticateCustomer(req: Request, res: Response, next: NextFunction) {
  return run(req, res, next, true)
}

/** Sesión de cliente opcional: sin header ⇒ invitado; header presente ⇒ se valida igual. */
export function authenticateCustomerOptional(req: Request, res: Response, next: NextFunction) {
  return run(req, res, next, false)
}
