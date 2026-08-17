/**
 * Mobile Cash Drawer Controller
 *
 * Handles cash drawer session management for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as cashDrawerService from '../../services/mobile/cash-drawer.mobile.service'

/**
 * Get current open cash drawer session
 * @route GET /api/v1/mobile/venues/:venueId/cash-drawer/current
 */
export const getCurrent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const session = await cashDrawerService.getCurrentSession(venueId)

    return res.json({
      success: true,
      data: session,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Open a new cash drawer session
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/open
 */
export const openSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { startingAmount, deviceName, staffName } = req.body

    if (startingAmount === undefined || startingAmount === null) {
      return res.status(400).json({ success: false, message: 'startingAmount es requerido' })
    }

    const session = await cashDrawerService.openSession({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      startingAmount: Number(startingAmount),
      deviceName,
    })

    return res.status(201).json({ success: true, data: session })
  } catch (error) {
    next(error)
  }
}

/**
 * 🔴 EL CÓDIGO DE UN MOVIMIENTO IDEMPOTENTE: 201 si se creó, 200 si YA ESTABA.
 *
 * Cuando el POS manda `localId` y la respuesta anterior se perdió, el reintento no crea
 * nada: se le devuelve el movimiento original. Decir 201 ("Created") ahí sería mentir sobre
 * lo único que el cajero necesita saber —si su retiro se registró una vez o dos—, y es la
 * señal que un operador ve en el log cuando investiga un descuadre.
 *
 * Por qué es SEGURO y no rompe a nadie:
 *   · Una app ya distribuida NO manda `localId`, así que jamás toma la rama del reintento:
 *     sigue recibiendo el mismo 201 de siempre, bit por bit.
 *   · Los dos clientes tratan cualquier 2xx como éxito (Android `code in 200..299`; iOS su
 *     `APIClient` genérico), así que una app nueva con llave tampoco se rompe.
 *   · El CUERPO es idéntico en los dos casos (el evento, con su `localId`), así que un
 *     cliente que ignore el código se comporta correctamente igual.
 *
 * Referencia: Stripe reproduce el código original de una petición idempotente porque
 * almacena la respuesta entera; nosotros no guardamos respuestas, así que el estado es la
 * forma barata y honesta de distinguir "lo creé" de "ya estaba". Square responde 200 a todo.
 * La regla es la MISMA en `pay-in` y `pay-out`.
 */
const idempotentStatus = (created: boolean) => (created ? 201 : 200)

/**
 * Add pay-in event
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/pay-in
 */
export const payIn = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { amount, note, staffName, localId } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount es requerido y debe ser mayor a 0' })
    }

    const { event, created } = await cashDrawerService.payIn({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      amount: Number(amount),
      note,
      localId,
    })

    return res.status(idempotentStatus(created)).json({ success: true, data: event })
  } catch (error) {
    next(error)
  }
}

/**
 * Add pay-out event
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/pay-out
 */
export const payOut = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { amount, note, staffName, localId } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount es requerido y debe ser mayor a 0' })
    }

    const { event, created } = await cashDrawerService.payOut({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      amount: Number(amount),
      note,
      localId,
    })

    return res.status(idempotentStatus(created)).json({ success: true, data: event })
  } catch (error) {
    next(error)
  }
}

/**
 * Close cash drawer session
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/close
 */
export const closeSession = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { actualAmount, note, staffName } = req.body

    if (actualAmount === undefined || actualAmount === null) {
      return res.status(400).json({ success: false, message: 'actualAmount es requerido' })
    }

    const session = await cashDrawerService.closeSession({
      venueId,
      staffId,
      staffName: staffName || 'Staff',
      actualAmount: Number(actualAmount),
      note,
    })

    return res.json({ success: true, data: session })
  } catch (error) {
    next(error)
  }
}

/**
 * Get cash drawer history (closed sessions)
 * @route GET /api/v1/mobile/venues/:venueId/cash-drawer/history
 */
export const getHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page as string) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 50)

    const result = await cashDrawerService.getHistory(venueId, page, pageSize)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * Tender breakdown (payments by method) for the corte de caja Z-report.
 * Query: ?from=<iso>&to=<iso> (the drawer session's window). Defaults to
 * [today 00:00, now] if omitted.
 * @route GET /api/v1/mobile/venues/:venueId/cash-drawer/tender-breakdown
 */
export const getTenderBreakdown = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const now = new Date()
    const from = req.query.from ? new Date(req.query.from as string) : new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const to = req.query.to ? new Date(req.query.to as string) : now

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({ success: false, message: 'from/to deben ser fechas ISO válidas' })
    }

    const result = await cashDrawerService.getTenderBreakdown(venueId, from, to)
    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Bulk sync events from mobile (offline-first)
 * @route POST /api/v1/mobile/venues/:venueId/cash-drawer/sync
 */
export const syncEvents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { events } = req.body

    if (!events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, message: 'events array es requerido' })
    }

    const result = await cashDrawerService.syncEvents(venueId, events)

    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * End-of-day summary ("Cierre del día"): the day's sales by tender + the
 * blockers a manager must clear (open checks, open drawers, clocked-in staff).
 * @route GET /api/v1/mobile/venues/:venueId/end-of-day
 */
export const getEndOfDay = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const { getEndOfDaySummary } = await import('../../services/mobile/end-of-day.mobile.service')
    const summary = await getEndOfDaySummary(venueId)
    return res.json({ success: true, data: summary })
  } catch (error) {
    next(error)
  }
}
