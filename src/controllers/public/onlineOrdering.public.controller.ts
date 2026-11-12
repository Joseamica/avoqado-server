import type { Request, Response } from 'express'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import type { CustomerAuthContext } from '@/middlewares/customerAuth.middleware'
import { assertOrderingPlan } from '@/middlewares/requirePublicVenueFeatureStrict.middleware'
import { assertOperationalVenue } from '@/middlewares/resolveOperationalVenueBySlug.middleware'
import { ACCEPT_TIMEOUT_MINUTES } from '@/services/online-ordering/constants'
import { closesAt } from '@/services/online-ordering/hours'
import { getPublicMenu } from '@/services/online-ordering/menu.service'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'
import { abandonCardPayment, createOnlineOrder, getTrackingByToken } from '@/services/online-ordering/order.service'
import { clientaDeLaSesion } from '@/services/online-ordering/clientaDeLaSesion'
import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { cardOnlineAvailable } from '@/services/online-ordering/card/merchant'
import { cuentaConBeneficios } from '@/services/online-ordering/cuentaConBeneficios'
import { buildVenueContact } from '@/services/online-ordering/settings.service'
import { toPublicQuote } from '@/services/online-ordering/quote.service'
import { cotizarConBeneficios, type EleccionDeBeneficios } from '@/services/online-ordering/beneficios.service'
import { cancelOnlineOrderByCustomer } from '@/services/online-ordering/transitions.service'

/** R8: de 32 a 64 caracteres. Una llave corta se adivina; la repetición además exige al mismo cliente (servicio). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{32,64}$/
const venueOf = (req: Request) => (req as any).publicVenue as { id: string; slug: string }

function fail(res: Response, error: any, fallback: string) {
  const status: number = error?.statusCode ?? 500
  // Nombre y pila SÓLO al log del servidor (para diagnosticar un 5xx en producción); al comensal, el texto genérico.
  if (status >= 500) logger.error('[OnlineOrdering] error público', { error: error?.message, name: error?.name, stack: error?.stack })
  // Un 5xx no expone su código interno (p. ej. el de Prisma). Excepción explícita: «no pudimos verificar el plan» (503 nuestro,
  // con texto para el comensal) conserva su código: la tienda sabe que puede reintentar. Igual «no pudimos abrir la página de
  // pago» (502 nuestro, fase 2): el reintento con la misma llave recupera la sesión.
  // S11 (R2''): «no pudimos calcular tus beneficios» (503 nuestro) también: el reintento con la misma llave la vuelve a calcular.
  const expose =
    status < 500 ||
    (status === 503 && error?.code === 'FEATURE_CHECK_UNAVAILABLE') ||
    (status === 503 && error?.code === 'BENEFITS_CALCULATION_UNAVAILABLE') ||
    (status === 502 && error?.code === 'CARD_PROVIDER_UNAVAILABLE')
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
    const [state, row, conCuenta] = await Promise.all([
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
          heroImageUrl: true,
          address: true,
          city: true,
          state: true,
          zipCode: true,
          phone: true,
        },
      }),
      // D16: si falla, la tienda no se cae: sale sin el campo y enseña «Entrar» como antes.
      cuentaConBeneficios(venue.id).catch((error: any) => {
        logger.warn('[OnlineOrdering] /info sin cuentaConBeneficios: no se pudo calcular', { venueId: venue.id, error: error?.message })
        return undefined
      }),
    ])
    // Fase 2: la tienda sólo anuncia tarjeta si el switch está prendido Y el comercio puede cobrar hoy.
    const cardOnline = await cardOnlineAvailable(state.config, prisma, venue.id)
    // Sin ningún medio de pago vivo (pagar al recoger apagado y la tarjeta ya no cobra) la tienda no puede recibir pedidos: no se
    // anuncia OPEN. Se calcula aquí y no en `getAcceptingStatus` (esa lectura está en el camino caliente de crear pedidos).
    const noPaymentMode = state.status === 'OPEN' && !state.config.acceptsPayAtPickup && !cardOnline
    const status = noPaymentMode ? 'PAUSED' : state.status
    const reason = noPaymentMode ? 'NO_PAYMENT_MODE' : state.reason
    return res.json({
      success: true,
      data: {
        venue: { slug: venue.slug, name: row?.name ?? null, timezone: row?.timezone ?? null, currency: row?.currency ?? 'MXN' },
        brand: {
          logo: row?.logo ?? null,
          logoFull: row?.logoFull ?? null,
          primaryColor: row?.primaryColor ?? null,
          secondaryColor: row?.secondaryColor ?? null,
          // Tienda rediseñada (aditivo): la misma `Venue.heroImageUrl` de la página de reservas; sin foto, null.
          heroImageUrl: row?.heroImageUrl ?? null,
        },
        status,
        reason,
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
        // T8 (aditivos): el modo de la tienda («Nadie» = false) y a qué hora cierra la franja vigente (ISO; null sin horario o fuera de él).
        requiresAcceptance: state.config.requiresAcceptance !== false,
        closesAt: closesAt(state.config.hours, new Date(), row?.timezone || 'America/Mexico_City')?.toISOString() ?? null,
        paymentModes: { payAtPickup: state.config.acceptsPayAtPickup, cardOnline },
        minOrderAmount: state.config.minOrderAmount,
        estimatedPrepMinutes: state.config.defaultPrepMinutes,
        acceptTimeoutMinutes: ACCEPT_TIMEOUT_MINUTES,
        // 1b: a quién y dónde reclamar (LFPC 76 Bis) y su aviso integral (LFPDPPP). La ruta es relativa al API público
        // (`GET /api/v1/public/venues/:venueId/privacy-notice`); la tienda le antepone su base.
        contact: buildVenueContact(row ?? {}),
        privacyNoticePath: `/venues/${venue.id}/privacy-notice`,
        // D16 (aditivo): `false` = ninguna clienta tiene nada de cuenta aquí ⇒ la tienda no invita a «Entrar»; sin el campo, como antes.
        ...(conCuenta === undefined ? {} : { cuentaConBeneficios: conCuenta }),
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
    return fail(res, error, 'No se pudo cargar el menú')
  }
}

/** POST /quote — S10: con sesión de la clienta, además sus beneficios (`req.body.beneficios` = lo que eligió usar). */
export async function postQuote(req: Request, res: Response) {
  try {
    const auth = (req as any).customerAuth as CustomerAuthContext | null
    // S11 (E11): la MISMA regla de quién es la clienta que al crear el folio.
    const q = await cotizarConBeneficios(venueOf(req).id, req.body.items, {
      customerId: clientaDeLaSesion(auth),
      eleccion: req.body.beneficios ?? null,
    })
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
      paymentMode: 'PAY_AT_PICKUP' | 'CARD_ONLINE'
      expectedTotal: string
      customer: { name: string; phone?: string; email?: string }
      note?: string
      whatsappConsent?: boolean
      channel?: 'QR' | 'LINK'
      beneficios?: EleccionDeBeneficios
    }
    // P1-06: negocio operativo y plan sólo para un pedido NUEVO; su rechazo se decide después de buscar la repetición.
    const opts = { assertCanCreate: () => assertOperationalVenue(venue.id).then(() => assertOrderingPlan(venue.id)) }
    // R6/H1: el cliente y el teléfono PROBADO salen de la sesión, nunca del cuerpo. S11 (E11): la MISMA regla que cotizar.
    const auth = (req as any).customerAuth as CustomerAuthContext | null

    // Fase 2: con tarjeta no se pide OTP (la tarjeta apartada respalda el pedido): borrador + página de pago de Stripe.
    if (body.paymentMode === 'CARD_ONLINE') {
      const draft = await createCardOnlineDraft(
        {
          venueId: venue.id,
          venueSlug: venue.slug,
          idempotencyKey: key,
          items: body.items,
          expectedTotal: body.expectedTotal,
          // R7: con tarjeta el esquema exige el teléfono. R29: el borrador de tarjeta no guarda canal.
          customer: { name: body.customer.name, phone: body.customer.phone as string, email: body.customer.email ?? null },
          note: body.note ?? null,
          whatsappConsent: body.whatsappConsent === true,
          // S11: la clienta cuenta si su teléfono probado es el del pedido (lo decide el servicio); con ella, sus beneficios.
          customerId: clientaDeLaSesion(auth),
          verifiedPhone: auth?.verifiedPhone ?? null,
          beneficios: body.beneficios ?? null,
        },
        opts,
      )
      return res.status(draft.replay ? 200 : 201).json({ success: true, data: draft })
    }

    // En «Mi equipo» el servicio exige que el teléfono del pedido sea el probado (sin sesión, 401 PHONE_VERIFICATION_REQUIRED); en
    // «Nadie» basta el nombre y, con una sesión que probó algún contacto, el folio nace con su clienta (S11) o anónimo (T7).

    const result = await createOnlineOrder(
      {
        venueId: venue.id,
        idempotencyKey: key,
        items: body.items,
        paymentMode: 'PAY_AT_PICKUP',
        expectedTotal: body.expectedTotal,
        customer: { name: body.customer.name, phone: body.customer.phone ?? null, email: body.customer.email ?? null },
        customerId: clientaDeLaSesion(auth),
        verifiedPhone: auth?.verifiedPhone ?? null,
        beneficios: body.beneficios ?? null,
        channel: body.channel ?? null,
        note: body.note ?? null,
        whatsappConsent: body.whatsappConsent === true,
      },
      opts,
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

/** POST /orders/:trackingToken/abandon-payment — S5: regresó de Stripe sin pagar. Nunca cancela; responde el seguimiento. */
export async function postAbandonPayment(req: Request, res: Response) {
  try {
    const tracking = await abandonCardPayment({ venueId: venueOf(req).id, trackingToken: req.params.trackingToken })
    if (!tracking) return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', error: 'No encontramos ese pedido.' })
    const { venueId: _venueId, ...publicData } = tracking
    return res.json({ success: true, data: publicData })
  } catch (error) {
    return fail(res, error, 'No se pudo actualizar tu pago')
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
    if (r.outcome === 'CONFIRMING_PAYMENT') {
      return res.status(409).json({
        success: false,
        code: 'ONLINE_ORDER_CONFIRMING_PAYMENT',
        error: 'Confirmando el pago con el banco. Espera unos segundos.',
      })
    }
    // Un desenlace que cancelar no debería dar (p. ej. PAYMENT_REQUIRED) es un 500, nunca «no encontramos ese pedido».
    throw new Error(`Desenlace inesperado al cancelar un pedido en línea: ${r.outcome}`)
  } catch (error) {
    return fail(res, error, 'No se pudo cancelar tu pedido')
  }
}
