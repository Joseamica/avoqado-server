/**
 * Vales por área (AREA_TICKETS) — controlador móvil.
 *
 * Contrato CONGELADO §6 del spec. Las rutas y sus nombres NO se cambian: server y
 * Android se implementan contra esto en paralelo.
 *
 *   POST   /mobile/venues/:venueId/area-tickets              → abre cuenta
 *   GET    /mobile/venues/:venueId/area-tickets/:code        → resuelve
 *   POST   /mobile/venues/:venueId/area-tickets/:code/items  → agrega renglones
 *   POST   /mobile/venues/:venueId/area-tickets/:code/claim  → CHECKOUT_CLAIMED
 *   POST   /mobile/orders/:id/fulfill                        → entrega, idempotente
 *   GET    /mobile/venues/:venueId/fulfillment/pending       → vales pendientes
 *   POST   /mobile/devices/partition                         → asigna partición
 */

import { NextFunction, Request, Response } from 'express'

import logger from '../../config/logger'
import { resolveRequestVenueId } from '../../middlewares/checkPermission.middleware'
import * as areaTicketService from '../../services/mobile/areaTicket.mobile.service'

/**
 * El dispositivo se identifica por el MISMO header que ya usa el registro pasivo y el
 * outbox offline (`PosSyncIntent.deviceId`). Una sola identidad de dispositivo en toda
 * la plataforma — ver `.claude/rules/offline-first-y-hub-lan.md` §2.4: si un POS
 * presenta dos identidades, se ve como dos peers y todo lo que depende de "quién es
 * este aparato" (partición, área, árbitro del hub) deja de ser estable.
 */
function readDeviceUid(req: Request): string | undefined {
  const raw = req.headers['x-device-id']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : undefined
}

function readStaffId(req: Request, body?: any): string | undefined {
  return body?.staffId || (req as any).authContext?.userId
}

/**
 * POST /api/v1/mobile/venues/:venueId/area-tickets
 * Abre la cuenta con el código que ACUÑÓ el cliente.
 */
export const openAreaTicket = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { code, items, customerName, note, source } = req.body ?? {}

    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ success: false, message: 'code es requerido (el código acuñado por el dispositivo).' })
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items es requerido y debe traer al menos un renglón.' })
    }

    const ticket = await areaTicketService.openAreaTicket(venueId, {
      code: code.trim(),
      deviceUid: readDeviceUid(req) ?? '',
      staffId: readStaffId(req, req.body),
      items,
      customerName,
      note,
      source,
    })

    res.status(201).json({ success: true, ticket })
  } catch (error) {
    logger.error('Error in openAreaTicket controller:', error)
    next(error)
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/area-tickets/:code
 *
 * 🔴 SIEMPRE 200 con `state` + `message`, incluso para `NOT_FOUND`. El contrato §6
 * lista NOT_FOUND como una de las cuatro RESOLUCIONES del mismo endpoint, no como un
 * fallo de transporte, y §5.1 lo exige explícitamente: *"nunca un 404 mudo: el cajero
 * lo re-teclea tres veces antes de entender"*. Un 404 crudo llega al cliente como un
 * error de red genérico y el cajero no aprende nada.
 */
export const resolveAreaTicket = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, code } = req.params
    const result = await areaTicketService.resolveAreaTicket(venueId, code)
    res.status(200).json({ success: true, ...result })
  } catch (error) {
    logger.error('Error in resolveAreaTicket controller:', error)
    next(error)
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/area-tickets/:code/items
 */
export const addAreaTicketItems = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, code } = req.params
    const { items } = req.body ?? {}

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'items es requerido y debe traer al menos un renglón.' })
    }

    const ticket = await areaTicketService.addAreaTicketItems(venueId, code, {
      deviceUid: readDeviceUid(req) ?? '',
      staffId: readStaffId(req, req.body),
      items,
    })

    res.status(200).json({ success: true, ticket })
  } catch (error) {
    logger.error('Error in addAreaTicketItems controller:', error)
    next(error)
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/area-tickets/:code/claim
 */
export const claimAreaTicket = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, code } = req.params
    const ticket = await areaTicketService.claimAreaTicket(venueId, code, {
      deviceUid: readDeviceUid(req) ?? '',
      staffId: readStaffId(req, req.body),
    })
    res.status(200).json({ success: true, ticket })
  } catch (error) {
    logger.error('Error in claimAreaTicket controller:', error)
    next(error)
  }
}

/**
 * POST /api/v1/mobile/orders/:id/fulfill
 *
 * Idempotente: el segundo intento responde 200 con `created: false` y la hora y
 * persona de la entrega ORIGINAL. Nunca un error — un error haría que el área dudara
 * y entregara dos veces.
 */
export const fulfillOrderArea = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params
    const { fulfillmentAreaId } = req.body ?? {}
    // 🔴 EL MISMO resolvedor QUE `checkPermission`. Esta ruta no lleva `:venueId` (así
    // está congelado el contrato §6), así que el venue sale de `x-venue-id` o del
    // token. Si aquí resolviéramos distinto que el gate de permisos, el permiso se
    // evaluaría contra un local y la entrega se ejecutaría en otro — el fallo sería
    // silencioso y sólo visible en un reporte de entregas que no cuadra.
    const venueId = resolveRequestVenueId(req, (req as any).authContext ?? {})
    if (!venueId) {
      return res.status(401).json({ success: false, message: 'No hay local en el contexto de sesión.' })
    }
    if (typeof fulfillmentAreaId !== 'string' || !fulfillmentAreaId.trim()) {
      return res.status(400).json({ success: false, message: 'fulfillmentAreaId es requerido.' })
    }

    const result = await areaTicketService.fulfillOrderArea(venueId, id, {
      fulfillmentAreaId: fulfillmentAreaId.trim(),
      deviceUid: readDeviceUid(req),
      staffId: readStaffId(req, req.body),
    })

    res.status(200).json({ success: true, fulfillment: result })
  } catch (error) {
    logger.error('Error in fulfillOrderArea controller:', error)
    next(error)
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/fulfillment/pending
 */
export const listPendingFulfillment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { fulfillmentAreaId } = req.query

    const result = await areaTicketService.listPendingFulfillment(venueId, {
      fulfillmentAreaId: typeof fulfillmentAreaId === 'string' ? fulfillmentAreaId : null,
      deviceUid: readDeviceUid(req),
    })

    res.status(200).json({ success: true, ...result })
  } catch (error) {
    logger.error('Error in listPendingFulfillment controller:', error)
    next(error)
  }
}

/**
 * POST /api/v1/mobile/devices/partition
 *
 * Se llama al iniciar sesión. Idempotente: el mismo dispositivo recibe SIEMPRE su
 * misma partición.
 */
export const assignDevicePartition = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = resolveRequestVenueId(req, (req as any).authContext ?? {})
    if (!venueId) {
      return res.status(401).json({ success: false, message: 'No hay local en el contexto de sesión.' })
    }

    const deviceUid = readDeviceUid(req) ?? (typeof req.body?.deviceUid === 'string' ? req.body.deviceUid.trim() : undefined)
    if (!deviceUid) {
      return res.status(400).json({ success: false, message: 'Falta el identificador del dispositivo (X-Device-Id).' })
    }

    const result = await areaTicketService.assignDevicePartition(venueId, {
      deviceUid,
      staffId: readStaffId(req, req.body),
      fulfillmentAreaId: typeof req.body?.fulfillmentAreaId === 'string' ? req.body.fulfillmentAreaId : null,
    })

    res.status(200).json({ success: true, device: result })
  } catch (error) {
    logger.error('Error in assignDevicePartition controller:', error)
    next(error)
  }
}
