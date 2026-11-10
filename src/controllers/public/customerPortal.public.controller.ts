import { Request, Response, NextFunction } from 'express'
import * as customerPortalService from '../../services/public/customerPortal.public.service'
import { NotFoundError } from '../../errors/AppError'
import type { CustomerAuthContext } from '../../middlewares/customerAuth.middleware'
import prisma from '../../utils/prismaClient'
import { computeBookingAccess, withBookingAccess } from '../../services/public/bookingAccess.service'
import { guardarTarjetaEnMiCuenta } from '../../services/giftCards/giftCardClaim.service'
import { ipDelCliente } from '../../utils/clientIp'

async function resolveVenueBySlug(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: { slug: venueSlug, active: true },
    select: { id: true },
  })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  return venue
}

/**
 * POST /public/venues/:venueSlug/customer/register — toda cuenta nueva se crea con código (`auth/otp/*`); esto sólo le dice
 * a una página vieja qué hacer (ver `registerCustomer`).
 */
export function register(_req: Request, _res: Response, next: NextFunction) {
  try {
    customerPortalService.registerCustomer()
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/customer/login
 */
export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { email, password } = req.body

    const result = await customerPortalService.loginCustomer(venue.id, email, password)

    const bookingAccess = await computeBookingAccess(venue.id, result.customer?.id)
    res.json({ ...result, ...withBookingAccess(bookingAccess) })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/customer/portal
 * Requires customer auth token
 */
export async function getPortal(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = (req as any).customerAuth as CustomerAuthContext
    const { customerId, venueId } = auth

    // S7: las reservas de invitada dependen de los contactos que probó ESTA sesión.
    const result = await customerPortalService.getCustomerPortal(venueId, customerId, auth)

    const bookingAccess = await computeBookingAccess(venueId, customerId)
    res.json({ ...result, ...withBookingAccess(bookingAccess) })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /public/venues/:venueSlug/customer/profile
 * Requires customer auth token
 */
export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { customerId, venueId } = (req as any).customerAuth as CustomerAuthContext
    const { firstName, lastName, phone } = req.body

    const result = await customerPortalService.updateProfile(venueId, customerId, {
      firstName,
      lastName,
      phone,
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/customer/phone/request — S8: pide el código al número NUEVO.
 */
export async function requestPhoneChange(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = (req as any).customerAuth as CustomerAuthContext
    res.json(await customerPortalService.pedirCambioDeTelefono(auth.venueId, auth, req.body.phone, req.ip))
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/customer/phone/verify — S8: confirma el código; responde la sesión nueva.
 */
export async function verifyPhoneChange(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = (req as any).customerAuth as CustomerAuthContext
    res.json(await customerPortalService.confirmarCambioDeTelefono(auth.venueId, auth, req.body.phone, req.body.code))
  } catch (error) {
    next(error)
  }
}

// ---- S13 (P2-6): «Mi cuenta» por páginas y «Guardar en mi cuenta» ----

/** `?cursor=&limit=` ya validados por la ruta; el tamaño lo recorta el servicio (1 a 50). */
const pedirPagina = (req: Request) => ({
  cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
  limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
})

/** GET /public/venues/:venueSlug/customer/orders — sus pedidos en línea, por páginas. */
export async function listMyOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { customerId, venueId } = (req as any).customerAuth as CustomerAuthContext
    res.json(await customerPortalService.listarMisPedidos(venueId, customerId, pedirPagina(req)))
  } catch (error) {
    next(error)
  }
}

/** GET /public/venues/:venueSlug/customer/gift-cards — las tarjetas que ella guardó, por páginas (código sólo con contacto probado). */
export async function listMyGiftCards(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = (req as any).customerAuth as CustomerAuthContext
    res.json(await customerPortalService.listarMisTarjetas(auth.venueId, auth.customerId, auth, pedirPagina(req)))
  } catch (error) {
    next(error)
  }
}

/** GET /public/venues/:venueSlug/customer/discounts — sus descuentos vigentes (asignados y de su grupo), por páginas. */
export async function listMyDiscounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { customerId, venueId } = (req as any).customerAuth as CustomerAuthContext
    res.json(await customerPortalService.listarMisDescuentos(venueId, customerId, pedirPagina(req)))
  } catch (error) {
    next(error)
  }
}

/** POST /public/venues/:venueSlug/customer/gift-cards/claim — «Guardar en mi cuenta» con el código de la tarjeta. */
export async function claimGiftCard(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = (req as any).customerAuth as CustomerAuthContext
    res.json(await guardarTarjetaEnMiCuenta(auth.venueId, auth, req.body.code, { ip: ipDelCliente(req) ?? null }))
  } catch (error) {
    next(error)
  }
}
