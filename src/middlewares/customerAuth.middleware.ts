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
 *   firma inválida / expirado / tipo no permitido → 401 CUSTOMER_TOKEN_INVALID
 *   payload.venueId ≠ venue de la URL         → 401 CUSTOMER_TOKEN_VENUE_MISMATCH (sin tocar DB)
 *   Customer {id, venueId} no existe          → 401 CUSTOMER_TOKEN_INVALID (no revelar que existió)
 *   Customer.active = false                   → 401 CUSTOMER_INACTIVE
 *
 * Depende de que `req.publicVenue` venga ya resuelto por `resolveVenueBySlug` — el venue de
 * la URL manda, no el del token. Si falta, es una ruta mal cableada: 500, nunca dejar pasar.
 */

import { Request, Response, NextFunction } from 'express'
import {
  verifyCustomerToken,
  verifyOrderingCustomerToken,
  verifyCustomerSession,
  generateCustomerSession,
  type ContactoProbado,
  type CustomerSessionPayload,
  type CustomerTokenPayload,
  type OrderingCustomerTokenPayload,
} from '../jwt.service'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { phonesMatch } from '../utils/phone'
import { activateCustomerAccount } from '../services/public/customerBookingAccess.service'
import { withDeadlockRetry } from '../utils/serializableRetry'

export interface CustomerAuthContext {
  customerId: string
  venueId: string
  tipo: 'SESION' | 'RESERVAS_DE_HOY' | 'PEDIDOS_DE_HOY'
  contactos: ContactoProbado[]
  accountActivatedAt: Date | null
  /** Sólo el teléfono probado por la sesión o firmado por el token de pedidos anterior. */
  verifiedPhone?: string
  /** S8: la versión con que se firmó la sesión (sólo `SESION`; los dos tokens de hoy cuentan como 0, igual que arriba). */
  v?: number
}

export interface PublicVenueContext {
  id: string
  slug: string
}

type AuthFailure = {
  status: 401
  code:
    | 'CUSTOMER_AUTH_REQUIRED'
    | 'CUSTOMER_TOKEN_INVALID'
    | 'CUSTOMER_TOKEN_VENUE_MISMATCH'
    | 'CUSTOMER_INACTIVE'
    | 'CUSTOMER_REAUTH_REQUIRED'
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
  CUSTOMER_REAUTH_REQUIRED: { status: 401, code: 'CUSTOMER_REAUTH_REQUIRED', message: 'Entra otra vez para cambiar tu número' },
}

type UsoDeCliente = 'RESERVAS' | 'PEDIDOS' | 'CAMBIO_DE_NUMERO'

/**
 * Resuelve la identidad a partir del header. Devuelve el contexto, `null` si no hay
 * header (el caller decide si eso es invitado o 401), o un fallo tipado.
 */
async function resolveCustomerAuth(
  req: Request,
  uso: UsoDeCliente,
): Promise<{ ok: true; auth: CustomerAuthContext | null; session?: CustomerSessionPayload } | { ok: false; failure: AuthFailure }> {
  const authHeader = req.headers.authorization
  // Sólo la AUSENCIA del header es invitado. Un header presente pero vacío (`Authorization: `)
  // es un cliente mal configurado, no un invitado: se rechaza como cualquier token inválido.
  if (authHeader === undefined) {
    return { ok: true, auth: null }
  }

  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_INVALID }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_INVALID }
  }

  let payload: CustomerSessionPayload | CustomerTokenPayload | OrderingCustomerTokenPayload
  try {
    try {
      payload = verifyCustomerSession(token)
    } catch {
      if (uso === 'RESERVAS') payload = verifyCustomerToken(token)
      else if (uso === 'PEDIDOS') payload = verifyOrderingCustomerToken(token)
      else {
        try {
          payload = verifyOrderingCustomerToken(token)
        } catch {
          payload = verifyCustomerToken(token)
        }
      }
    }
    if (typeof payload.sub !== 'string' || typeof payload.venueId !== 'string') throw new Error('Identidad inválida')
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
    select: { id: true, venueId: true, active: true, versionDeSesion: true, phone: true, email: true, accountActivatedAt: true },
  })
  if (!customer) {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_INVALID }
  }
  if (!customer.active) {
    return { ok: false, failure: FAIL.CUSTOMER_INACTIVE }
  }

  const session = payload.type === 'customer_session' ? (payload as CustomerSessionPayload) : undefined
  const contactos = session?.contactos ?? []
  const verifiedPhone =
    session?.contactos.find(contacto => contacto.tipo === 'PHONE')?.valor ??
    (payload.type === 'customer_ordering' ? (payload as OrderingCustomerTokenPayload).verifiedPhone : undefined)
  if (
    (session?.v ?? 0) < customer.versionDeSesion ||
    (verifiedPhone !== undefined && !phonesMatch(verifiedPhone, customer.phone)) ||
    contactos.some(contacto =>
      contacto.tipo === 'PHONE'
        ? !phonesMatch(contacto.valor, customer.phone)
        : contacto.valor.trim().toLowerCase() !== customer.email?.trim().toLowerCase(),
    )
  ) {
    return { ok: false, failure: FAIL.CUSTOMER_TOKEN_INVALID }
  }
  if (uso === 'CAMBIO_DE_NUMERO' && payload.type === 'customer') {
    return { ok: false, failure: FAIL.CUSTOMER_REAUTH_REQUIRED }
  }

  return {
    ok: true,
    auth: {
      customerId: customer.id,
      venueId: customer.venueId,
      tipo: session ? 'SESION' : payload.type === 'customer' ? 'RESERVAS_DE_HOY' : 'PEDIDOS_DE_HOY',
      contactos,
      accountActivatedAt: customer.accountActivatedAt,
      ...(verifiedPhone ? { verifiedPhone } : {}),
      ...(session ? { v: session.v } : {}),
    },
    ...(session ? { session } : {}),
  }
}

function reply(res: Response, failure: AuthFailure) {
  return res.status(failure.status).json({ message: failure.message, code: failure.code })
}

async function run(req: Request, res: Response, next: NextFunction, required: boolean, uso: UsoDeCliente) {
  let result: Awaited<ReturnType<typeof resolveCustomerAuth>>
  try {
    result = await resolveCustomerAuth(req, uso)
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
  if (result.session && Date.now() / 1000 - result.session.iat! > 86400) {
    res.setHeader('x-customer-session', generateCustomerSession(result.session))
  }
  return next()
}

/** Sesión de cliente obligatoria. */
export function authenticateCustomer(req: Request, res: Response, next: NextFunction) {
  return run(req, res, next, true, 'RESERVAS')
}

/** Sesión de cliente opcional: sin header ⇒ invitado; header presente ⇒ se valida igual. */
export function authenticateCustomerOptional(req: Request, res: Response, next: NextFunction) {
  return run(req, res, next, false, 'RESERVAS')
}

/**
 * Sesión opcional para pedidos: acepta sesión única o el token anterior de pedidos; sin cabecera sigue como invitado.
 */
export function authenticateOrderingCustomerOptional(req: Request, res: Response, next: NextFunction) {
  return run(req, res, next, false, 'PEDIDOS')
}

export function authenticateCustomerParaCambioDeNumero(req: Request, res: Response, next: NextFunction) {
  return run(req, res, next, true, 'CAMBIO_DE_NUMERO')
}

/** Autenticar para pedir no activa reservas: sólo estos caminos pasan por la activación existente. */
export async function activarReservasSiFalta(req: Request, _res: Response, next: NextFunction) {
  const auth = (req as any).customerAuth as CustomerAuthContext | null
  if (auth?.tipo !== 'SESION' || auth.accountActivatedAt != null) return next()
  try {
    await withDeadlockRetry(tx => activateCustomerAccount(tx, { customerId: auth.customerId, venueId: auth.venueId, origin: 'OTP' }), {
      etiqueta: 'activarReservasSiFalta',
    })
    return next()
  } catch (error) {
    return next(error)
  }
}
