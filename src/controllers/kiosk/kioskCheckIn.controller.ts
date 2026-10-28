/**
 * Fase 5 del kiosco — HTTP del reto de check-in.
 *
 * Dos caras del mismo mecanismo:
 *
 *   · el APARATO (TPV) pide un reto y luego pregunta "¿ya lo resolvió alguien?";
 *   · el TELÉFONO del cliente lo consume con SU sesión, desde el widget.
 *
 * El aparato nunca ve quién fue. Es lo que permite poner esto en una pantalla que mira
 * la fila entera.
 */

import { NextFunction, Request, Response } from 'express'
import { z } from 'zod'

import {
  CHALLENGE_TTL_SECONDS,
  checkInByIdentifier,
  consumeKioskCheckInChallenge,
  createKioskCheckInChallenge,
  getKioskCheckInChallengeStatus,
  getKioskRoster,
  kioskCheckInReservation,
} from '@/services/reservation/kioskCheckIn.service'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'
import { createKioskPackCheckout, getAvailablePacks, getKioskPackCheckoutStatus } from '@/services/dashboard/creditPack.public.service'
import { canVenueChargeOnline } from '@/services/payments/ecommerceCapability'

/** Nada de esto se cachea, y el secreto no debe viajar en un `Referer`. */
function harden(res: Response) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
}

/**
 * El local sale del token de la terminal (carril TPV) o de la ruta (carril móvil, que es
 * por donde entra avoqado-android: el kiosco corre con la sesión que la app ya tiene).
 * Cuando vienen los dos, tienen que coincidir — un token de un local no opera otro.
 */
function resolveVenueId(req: Request): string {
  const fromToken = req.authContext?.venueId
  const fromRoute = req.params.venueId
  if (fromRoute && fromToken && fromRoute !== fromToken) {
    throw new UnauthorizedError('Tu sesión es de otro local', 'CUSTOMER_TOKEN_VENUE_MISMATCH')
  }
  const venueId = fromRoute || fromToken
  if (!venueId) throw new UnauthorizedError('Sesión sin local')
  return venueId
}

/** POST /api/v1/tpv/kiosk/challenge */
export async function createChallenge(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const venueId = resolveVenueId(req)
    const stationKey = String(req.body?.stationKey ?? 'B').slice(0, 8)
    const kioskSessionId = String(req.body?.kioskSessionId ?? '').slice(0, 64)
    if (!kioskSessionId) throw new BadRequestError('kioskSessionId es requerido')

    const out = await createKioskCheckInChallenge({
      venueId,
      terminalId: req.authContext?.terminalSerialNumber ?? null,
      stationKey,
      kioskSessionId,
      now: new Date(),
    })

    res.status(201).json({
      challengeId: out.id,
      secret: out.secret,
      expiresAt: out.expiresAt,
      ttlSeconds: CHALLENGE_TTL_SECONDS,
    })
  } catch (error) {
    next(error)
  }
}

/** GET /api/v1/tpv/kiosk/challenge/:challengeId — sondeo SIN PII. */
export async function getChallenge(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const venueId = resolveVenueId(req)
    const out = await getKioskCheckInChallengeStatus({
      venueId,
      challengeId: req.params.challengeId,
      now: new Date(),
    })
    res.json(out)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/tpv/kiosk/check-in-by-code  (D9)
 *
 * El respaldo de "no aparezco en la lista": se teclea el TELÉFONO (o el código de
 * confirmación) en el propio kiosco. Lo protege un límite de intentos DURABLE por terminal, cara, IP y
 * reserva — y una respuesta genérica, para que no se pueda usar como buscador de códigos.
 */
export async function checkInByCode(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const venueId = resolveVenueId(req)
    // Se acepta `identifier` (teléfono o código); `code` sigue funcionando por si algún
    // cliente ya lo manda así — quitar un campo de una API rompe versiones viejas.
    const identifier = String(req.body?.identifier ?? req.body?.code ?? '').trim()
    if (!identifier) throw new BadRequestError('identifier es requerido')

    const out = await checkInByIdentifier({
      venueId,
      terminalId: req.authContext?.terminalSerialNumber ?? null,
      stationKey: String(req.body?.stationKey ?? 'B').slice(0, 8),
      identifier,
      now: new Date(),
      ip: req.ip,
    })
    res.json(out)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/kiosk/roster  (0.e)
 *
 * La clase del kiosco ahora mismo. Sin `from/to`: la ventana la calcula el servidor (un rango del
 * aparato sólo podría ampliarla). `closesAt`/`closesInMs` son para la cola sin red del aparato.
 */
export async function kioskRoster(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const venueId = resolveVenueId(req)
    res.json({ roster: await getKioskRoster({ venueId, now: new Date() }) })
  } catch (error) {
    next(error)
  }
}

// Los dos o ninguno: vacío = toque en vivo; con ellos = toque guardado sin red (hora = closesAt − msBeforeClose).
const reservationCheckInBody = z
  .object({
    closesAt: z.string({ invalid_type_error: 'Hora de cierre inválida' }).datetime({ message: 'Hora de cierre inválida' }),
    // Tope de 24 h: un número enorme volvería inválida la hora del toque (y un 500 en vez de un 400).
    msBeforeClose: z
      .number({ invalid_type_error: 'Tiempo inválido' })
      .int('Tiempo inválido')
      .positive('Tiempo inválido')
      .max(24 * 60 * 60_000, 'Tiempo fuera de rango'),
  })
  .partial()
  .refine(b => !b.closesAt === !b.msBeforeClose, 'Manda closesAt y msBeforeClose juntos')

/**
 * POST /api/v1/mobile/venues/:venueId/kiosk/reservations/:reservationId/check-in  (0.e)
 *
 * body opcional `{ closesAt, msBeforeClose }` → `{ reservationId, orderId }`.
 * 422 CHECK_IN_OUTSIDE_WINDOW · 422 CHECK_IN_TOO_OLD · 409 RESERVATION_NOT_CHECKINABLE.
 */
export async function kioskReservationCheckIn(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const venueId = resolveVenueId(req)
    const parsed = reservationCheckInBody.safeParse(req.body ?? {})
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Solicitud incorrecta')
    const { closesAt, msBeforeClose } = parsed.data

    const out = await kioskCheckInReservation({
      venueId,
      reservationId: req.params.reservationId,
      now: new Date(),
      tapped: closesAt && msBeforeClose ? { closesAt: new Date(closesAt), msBeforeClose } : undefined,
    })
    res.json(out)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/public/venues/:venueSlug/customer/checkin/:challengeId
 *
 * Desde el teléfono del cliente, con SU sesión. El secreto va en el BODY —nunca en la
 * ruta ni en la query— porque esos sí quedan en logs y en el historial del navegador.
 */
export async function consumeChallenge(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const auth = (req as any).customerAuth as { customerId: string; venueId: string } | null
    const venue = (req as any).publicVenue as { id: string } | undefined
    if (!auth) throw new UnauthorizedError('Inicia sesión para hacer tu check-in', 'CUSTOMER_AUTH_REQUIRED')
    if (!venue) throw new BadRequestError('Local no resuelto')

    // El middleware ya compara token ↔ venue; esto es el cinturón del cinturón.
    if (auth.venueId !== venue.id) {
      throw new UnauthorizedError('Tu sesión es de otro local', 'CUSTOMER_TOKEN_VENUE_MISMATCH')
    }

    const secret = String(req.body?.secret ?? '')
    if (!secret) throw new BadRequestError('secret es requerido')

    const out = await consumeKioskCheckInChallenge({
      venueId: venue.id,
      challengeId: req.params.challengeId,
      secret,
      customerId: auth.customerId,
      now: new Date(),
      ip: req.ip,
    })
    res.json(out)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/kiosk/packs
 *
 * Los paquetes que el kiosco puede ofrecer. Precio de CATÁLOGO, sin excepción: el kiosco
 * no elige cuánto cobrar, y eso es lo que hace que un cobro sin PIN de empleado sea
 * seguro. (Decisión del founder: el autoservicio NO pide PIN — un kiosco que lo pide no
 * es un kiosco. La frontera no es "dinero sí/no", es quién decide el monto.)
 */
export async function kioskPacks(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const venueId = resolveVenueId(req)

    // 🔴 Si el negocio no puede cobrar en línea, NO se ofrecen paquetes.
    //
    // El kiosco no debe presentar un camino que no puede terminar: el cliente elegiría un
    // paquete, esperaría el QR y se toparía con un error después de haber decidido comprar.
    // Es peor que no ofrecerlo. Se vio en la D3 con un venue sin Stripe conectado.
    //
    // `canSellOnline` viaja aparte del arreglo vacío para que la app pueda distinguir
    // "este negocio no vende paquetes" de "no puede cobrarlos todavía" — el segundo es un
    // pendiente de configuración del negocio, no una ausencia deliberada.
    const canSellOnline = await canVenueChargeOnline(venueId)
    const packs = canSellOnline ? await getAvailablePacks(venueId) : []
    res.json({ packs, canSellOnline })
  } catch (error) {
    next(error)
  }
}

const packCheckoutBody = z.object({
  packId: z.string().min(1, 'Elige un paquete'),
  // E.164 (máx. 15 dígitos con la lada). El kiosco compone «+<lada><número>»: 10 dígitos con +52 o +1, de 8 en
  // adelante con otra lada (Cuba: +53 y 8 dígitos = 10 en total).
  // 🔴 Al menos 11 dígitos: «+» + 10 lo lee `@/utils/phone` como celular mexicano mal guardado, y «+49 20123456» caería
  // en la ficha de «+52 4920123456» (Codex r2, D3). El kiosco ya no deja mandar uno así.
  phone: z.string().regex(/^\+\d{11,15}$/, 'Escribe tu teléfono completo'),
})

/**
 * POST /api/v1/mobile/venues/:venueId/kiosk/pack-checkout · body `{ packId, phone }`
 *
 * Devuelve `{ url, sessionId, expiresAt }`: la URL se enseña como QR y `sessionId` sirve para
 * preguntar si ya se pagó.
 *
 * 🔴 El cliente paga en SU teléfono, no en la pantalla del kiosco. Es lo que dice el spec
 * ("CreditPack → PAX o Stripe Checkout como QR") y resuelve dos cosas de una:
 *   · nadie mete su tarjeta en un aparato compartido de la entrada; y
 *   · reutiliza el carril de pago en línea que YA existe y ya está probado, en vez de
 *     estrenar código nuevo en el camino del dinero.
 * El teléfono es para que las clases caigan a SU nombre (D3: sin contacto, Stripe cobraba y el
 * webhook no podía entregar). La respuesta no dice nada de la ficha encontrada.
 */
export async function kioskPackCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const venueId = resolveVenueId(req)
    const parsed = packCheckoutBody.safeParse(req.body ?? {})
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Solicitud incorrecta')

    res.json(await createKioskPackCheckout({ venueId, packId: parsed.data.packId, phone: parsed.data.phone }))
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/kiosk/pack-checkout/:sessionId/status
 *
 * El kiosco pregunta cada pocos segundos si ya se pagó. `PAID` sólo cuando las clases ya son
 * suyas (el webhook ya entregó); este sondeo nunca entrega nada.
 */
export async function kioskPackCheckoutStatus(req: Request, res: Response, next: NextFunction) {
  try {
    harden(res)
    const venueId = resolveVenueId(req)
    const sessionId = String(req.params.sessionId ?? '')
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new BadRequestError('Pago no encontrado')

    res.json({ status: await getKioskPackCheckoutStatus({ venueId, sessionId }) })
  } catch (error) {
    next(error)
  }
}
