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

import {
  CHALLENGE_TTL_SECONDS,
  checkInByIdentifier,
  consumeKioskCheckInChallenge,
  createKioskCheckInChallenge,
  getKioskCheckInChallengeStatus,
} from '@/services/reservation/kioskCheckIn.service'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'

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
