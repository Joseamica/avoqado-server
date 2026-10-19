import type { Request, Response } from 'express'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'
import { assertOrderingPlan } from '@/middlewares/requirePublicVenueFeatureStrict.middleware'
import { assertOperationalVenue } from '@/middlewares/resolveOperationalVenueBySlug.middleware'
import { ACCEPT_TIMEOUT_MINUTES } from '@/services/online-ordering/constants'
import { getPublicMenu } from '@/services/online-ordering/menu.service'
import { createOnlineOrder, getTrackingByToken } from '@/services/online-ordering/order.service'
import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { buildVenueContact } from '@/services/online-ordering/settings.service'
import { quoteCart, toPublicQuote } from '@/services/online-ordering/quote.service'
import { cancelOnlineOrderByCustomer } from '@/services/online-ordering/transitions.service'

/** R8: de 32 a 64 caracteres. Una llave corta se adivina; la repetición además exige al mismo cliente (servicio). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{32,64}$/
const venueOf = (req: Request) => (req as any).publicVenue as { id: string; slug: string }

function fail(res: Response, error: any, fallback: string) {
  const status: number = error?.statusCode ?? 500
  // Nombre y pila SÓLO al log del servidor (para diagnosticar un 5xx en producción); al comensal, el texto genérico.
  if (status >= 500) logger.error('[OnlineOrdering] error público', { error: error?.message, name: error?.name, stack: error?.stack })
  // Un 5xx no expone su código interno (p. ej. el de Prisma). Excepción explícita: «no pudimos verificar el plan» (503 nuestro,
  // con texto para el comensal) conserva su código: la tienda sabe que puede reintentar.
  const expose = status < 500 || (status === 503 && error?.code === 'FEATURE_CHECK_UNAVAILABLE')
  return res.status(status).json({
    success: false,
    code: expose ? error?.code : undefined,
    error: expose ? error.message : fallback,
    details: expose ? error?.details : undefined,
    // Codex r4: decisión DURABLE sobre la llave del pedido (`final()` en order.service): sólo con ella la tienda suelta un 404.
    final: error?.final === true ? true : undefined,
  })
}

/** GET /info */
export async function getInfo(req: Request, res: Response) {
  try {
    const venue = venueOf(req)
    const [state, row] = await Promise.all([
      getAcceptingStatus(venue.id),
      prisma.venue.findUnique({
        where: { id: venue.id },
        select: {
          name: true,
          timezone: true,
          currency: true,
          logo: true,
          logoFull: true,
          primaryColor: true,
          secondaryColor: true,
          address: true,
          city: true,
          state: true,
          zipCode: true,
          phone: true,
        },
      }),
    ])
    return res.json({
      success: true,
      data: {
        venue: { slug: venue.slug, name: row?.name ?? null, timezone: row?.timezone ?? null, currency: row?.currency ?? 'MXN' },
        brand: {
          logo: row?.logo ?? null,
          logoFull: row?.logoFull ?? null,
          primaryColor: row?.primaryColor ?? null,
          secondaryColor: row?.secondaryColor ?? null,
        },
        status: state.status,
        reason: state.reason,
        // S2: la pausa de 15/30/60 min de la bandeja y la del gerente comparten `reason`; la hora sólo se anuncia en la primera
        // (la del gerente no termina sola) y mientras siga vigente. La tienda dice «Volvemos a recibir pedidos a las HH:MM».
        pausedUntil:
          state.status === 'PAUSED' &&
          state.reason === 'MANUAL_PAUSE' &&
          !state.config.manualPause &&
          state.config.pausedUntil &&
          new Date(state.config.pausedUntil) > new Date()
            ? state.config.pausedUntil
            : null,
        hours: state.config.hours,
        paymentModes: { payAtPickup: state.config.acceptsPayAtPickup },
        minOrderAmount: state.config.minOrderAmount,
        estimatedPrepMinutes: state.config.defaultPrepMinutes,
        acceptTimeoutMinutes: ACCEPT_TIMEOUT_MINUTES,
        // 1b: a quién y dónde reclamar (LFPC 76 Bis) y su aviso integral (LFPDPPP). La ruta es relativa al API público
        // (`GET /api/v1/public/venues/:venueId/privacy-notice`); la tienda le antepone su base.
        contact: buildVenueContact(row ?? {}),
        privacyNoticePath: `/venues/${venue.id}/privacy-notice`,
      },
    })
  } catch (error) {
    return fail(res, error, 'No se pudo cargar la información de la tienda')
  }
}

/** GET /menu — la carta es un objeto COMPARTIDO de la caché (60 s): se responde tal cual, nunca se modifica aquí. */
export async function getMenu(req: Request, res: Response) {
  try {
    return res.json({ success: true, data: await getPublicMenu(venueOf(req).id) })
  } catch (error) {
    return fail(res, error, 'No se pudo cargar la carta')
  }
}

/** POST /quote */
export async function postQuote(req: Request, res: Response) {
  try {
    const q = await quoteCart(venueOf(req).id, req.body.items)
    return res.json({ success: true, data: toPublicQuote(q) })
  } catch (error) {
    return fail(res, error, 'No se pudo calcular tu pedido')
  }
}

/** POST /orders — `Idempotency-Key` obligatoria (32–64) y `expectedTotal`; 201 al crear, 200 si es una repetición. */
export async function postOrder(req: Request, res: Response) {
  try {
    const venue = venueOf(req)
    const key = (req.header('Idempotency-Key') ?? '').trim()
    if (!IDEMPOTENCY_KEY.test(key)) {
      return res.status(400).json({
        success: false,
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        error: 'Falta la llave de idempotencia (cabecera Idempotency-Key, de 32 a 64 caracteres).',
      })
    }

    const body = req.body as {
      items: any[]
      paymentMode: 'PAY_AT_PICKUP'
      expectedTotal: string
      customer: { name: string; phone: string; email?: string }
      note?: string
      whatsappConsent?: boolean
    }
    // R6/H1: el cliente y el teléfono PROBADO por el OTP de WhatsApp salen del token de PEDIDOS, nunca del cuerpo. El servicio
    // exige que el teléfono del pedido sea ése; sin sesión responde 401 PHONE_VERIFICATION_REQUIRED.
    const auth = (req as any).customerAuth as CustomerAuthContext | null

    const result = await createOnlineOrder(
      {
        venueId: venue.id,
        idempotencyKey: key,
        items: body.items,
        paymentMode: body.paymentMode,
        expectedTotal: body.expectedTotal,
        customer: { name: body.customer.name, phone: body.customer.phone, email: body.customer.email ?? null },
        customerId: auth?.customerId ?? null,
        verifiedPhone: auth?.verifiedPhone ?? null,
        note: body.note ?? null,
        whatsappConsent: body.whatsappConsent === true,
      },
      // P1-06: negocio operativo y plan sólo para un pedido NUEVO; su rechazo se decide después de buscar la repetición.
      { assertCanCreate: () => assertOperationalVenue(venue.id).then(() => assertOrderingPlan(venue.id)) },
    )
    return res.status(result.replay ? 200 : 201).json({ success: true, data: result })
  } catch (error) {
    return fail(res, error, 'No se pudo crear tu pedido')
  }
}

/** GET /orders/:trackingToken */
export async function getOrder(req: Request, res: Response) {
  try {
    const tracking = await getTrackingByToken(req.params.trackingToken)
    // El token vale sólo dentro del venue de la URL; el venueId interno nunca sale.
    if (!tracking || tracking.venueId !== venueOf(req).id) {
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', error: 'No encontramos ese pedido.' })
    }
    const { venueId: _venueId, ...publicData } = tracking
    return res.json({ success: true, data: publicData })
  } catch (error) {
    return fail(res, error, 'No se pudo consultar tu pedido')
  }
}

/** POST /orders/:trackingToken/cancel */
export async function postCancel(req: Request, res: Response) {
  try {
    const r = await cancelOnlineOrderByCustomer({ venueId: venueOf(req).id, trackingToken: req.params.trackingToken })
    if (r.outcome === 'OK') return res.json({ success: true, data: { status: r.status } })
    if (r.outcome === 'STALE') {
      return res.status(409).json({
        success: false,
        code: 'ORDER_STATE_CHANGED',
        status: r.status,
        error: 'Tu pedido ya no está por aceptar, así que no se puede cancelar desde aquí. Revisa su estado o llama al negocio.',
      })
    }
    if (r.outcome === 'HAS_PAYMENTS') {
      return res.status(409).json({
        success: false,
        code: 'ORDER_HAS_PAYMENTS',
        error: 'Tu pedido ya tiene un cobro en curso o registrado. Para cancelarlo, llama al negocio.',
      })
    }
    if (r.outcome === 'NOT_FOUND') {
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', error: 'No encontramos ese pedido.' })
    }
    // Un desenlace que cancelar no debería dar (p. ej. PAYMENT_REQUIRED) es un 500, nunca «no encontramos ese pedido».
    throw new Error(`Desenlace inesperado al cancelar un pedido en línea: ${r.outcome}`)
  } catch (error) {
    return fail(res, error, 'No se pudo cancelar tu pedido')
  }
}
