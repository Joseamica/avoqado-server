/**
 * Bandeja «Pedidos en línea» del restaurante. Vive en `/mobile` porque quien decide está en la tablet; el panel reutiliza
 * estos mismos manejadores bajo `/dashboard`. R13: sólo la bandeja en primer plano (`x-online-orders-tray: 1`) late.
 *
 * `:orderId` es SIEMPRE el id de la cuenta (`Order.id`, el `orderId` de la bandeja), nunca `onlineOrderId`.
 * R1: ninguna transición recibe `now` desde aquí: la transición toma su reloj DESPUÉS del candado de la orden.
 */
import type { NextFunction, Request, Response } from 'express'
import type { OnlineOrderRejectReason } from '@prisma/client'
import { evaluateRolePermission, resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { ONLINE_ORDERS_TRAY_HEADER } from '@/services/online-ordering/constants'
import { listInbox, type InboxFilter } from '@/services/online-ordering/inbox.service'
import { getAcceptingStatus, touchInboxPoll } from '@/services/online-ordering/presence.service'
import { pauseOnlineOrdering } from '@/services/online-ordering/settings.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByStaff,
  markOnlineOrderDelivered,
  markOnlineOrderReady,
  rejectOnlineOrder,
  type TransitionResult,
} from '@/services/online-ordering/transitions.service'
import { claimOnlineOrderPrint, confirmOnlineOrderPrinted } from '@/services/online-ordering/printClaim.service'
import type { FloorPauseMinutes } from '@/services/online-ordering/types'

const staffOf = (req: Request): string | null => (req as any).authContext?.userId ?? null
const deviceOf = (req: Request): string => (req.header('x-device-id') ?? '').trim()

function reply(res: Response, r: TransitionResult) {
  switch (r.outcome) {
    case 'OK': {
      const { outcome: _o, ...data } = r
      return res.json({ success: true, data })
    }
    case 'STALE':
      return res.status(409).json({
        success: false,
        code: 'ORDER_STATE_CHANGED',
        status: r.status,
        error: 'El pedido ya cambió de estado (otro aparato, el cliente, la caja o el tiempo). Actualiza la bandeja.',
      })
    case 'PAYMENT_REQUIRED':
      return res.status(409).json({ success: false, code: 'PAYMENT_REQUIRED', error: 'Cobra el pedido antes de entregarlo.' })
    case 'HAS_PAYMENTS':
      return res.status(409).json({
        success: false,
        code: 'ORDER_HAS_PAYMENTS',
        error:
          'El pedido ya tiene un cobro, o uno en curso en la terminal. Espera a que termine; si ya se cobró, usa el reembolso de la cuenta.',
      })
    case 'NOT_FOUND':
      return res.status(404).json({ success: false, code: 'ORDER_NOT_FOUND', error: 'No encontramos ese pedido.' })
    default:
      // Un resultado que este mapa no conoce es un error del servidor (500), nunca un «no existe» que engañe a la caja.
      throw new Error(`Resultado de transición desconocido: ${String((r as { outcome?: unknown }).outcome)}`)
  }
}

/**
 * H3 (r2): ¿quien consulta puede CONTESTAR pedidos en ESTE negocio? `orders:update` efectivo, con la MISMA resolución que
 * `checkPermission` (rol en el negocio + lista propia o permisos personalizados). La consulta del rol ya está memoizada en `req`
 * por el `checkPermission('orders:read')` de la ruta.
 */
async function canAnswerOrders(req: Request, venueId: string): Promise<boolean> {
  // Suplantando, `userId` es el suplantado pero la sesión es de sólo lectura: no puede contestar, así que no late.
  if ((req as any).authContext?.isImpersonating) return false
  const userId: string | undefined = (req as any).authContext?.userId
  if (!userId) return false
  const { role, permissionSet } = await resolveUserRoleForVenue({ userId, targetVenueId: venueId, req })
  return role ? evaluateRolePermission({ venueId, role, permissionSet, permission: 'orders:update' }) : false
}

export const inbox = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const filter = ((req.query.status as InboxFilter | undefined) ?? 'all') as InboxFilter
    const data = await listInbox({ venueId, filter })
    // R13: el latido va DESPUÉS de listar bien (una bandeja que falla no mantiene abierta la tienda) y sólo desde la pantalla
    // de bandeja en primer plano. H3: y sólo de quien puede contestar; un lector mira sin mantener abierta la tienda. Nunca le
    // cuesta la lista al restaurante.
    const latido = req.header(ONLINE_ORDERS_TRAY_HEADER) === '1' && (await canAnswerOrders(req, venueId).catch(() => false))
    if (latido) await touchInboxPoll(venueId).catch(() => false)
    // R13: el restaurante ve si su tienda está abierta, pausada, fuera de horario o sin aparato.
    const state = await getAcceptingStatus(venueId).catch(() => null)
    return res.json({ success: true, data: { ...data, store: state ? { status: state.status, reason: state.reason } : null } })
  } catch (e) {
    return next(e)
  }
}

export const accept = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const estimatedMinutes = typeof req.body?.estimatedMinutes === 'number' ? req.body.estimatedMinutes : undefined
    return reply(res, await acceptOnlineOrder({ venueId, orderId, staffId: staffOf(req), estimatedMinutes }))
  } catch (e) {
    return next(e)
  }
}

export const reject = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const reason = req.body.reason as OnlineOrderRejectReason
    // Una nota de puros espacios no es nota: se guarda `null`, no `""`.
    const note = typeof req.body.note === 'string' ? req.body.note.trim() || null : null
    return reply(res, await rejectOnlineOrder({ venueId, orderId, staffId: staffOf(req), reason, note }))
  } catch (e) {
    return next(e)
  }
}

export const ready = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    return reply(res, await markOnlineOrderReady({ venueId, orderId, staffId: staffOf(req) }))
  } catch (e) {
    return next(e)
  }
}

export const delivered = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    return reply(res, await markOnlineOrderDelivered({ venueId, orderId, staffId: staffOf(req) }))
  } catch (e) {
    return next(e)
  }
}

export const cancel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    return reply(res, await cancelOnlineOrderByStaff({ venueId, orderId, staffId: staffOf(req) }))
  } catch (e) {
    return next(e)
  }
}

/** R12: cocina y caja frenan la tienda 15/30/60 minutos o la reanudan (`minutes: null`). */
export const pause = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const minutes = (req.body?.minutes ?? null) as FloorPauseMinutes | null
    return res.json({ success: true, data: await pauseOnlineOrdering(venueId, minutes, staffOf(req)) })
  } catch (e) {
    return next(e)
  }
}

const needsDevice = (res: Response) =>
  res.status(400).json({ success: false, code: 'DEVICE_ID_REQUIRED', error: 'Falta la cabecera x-device-id.' })

export const printClaim = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = deviceOf(req)
    if (!deviceId) return needsDevice(res)
    const { venueId, orderId } = req.params
    return res.json({ success: true, data: await claimOnlineOrderPrint(venueId, orderId, deviceId) })
  } catch (e) {
    return next(e)
  }
}

/** `ok: false` = ya estaba sellada o este aparato perdió el reclamo (venció y otro lo tomó). NO significa «reimprime». */
export const printConfirm = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = deviceOf(req)
    if (!deviceId) return needsDevice(res)
    const { venueId, orderId } = req.params
    return res.json({ success: true, data: await confirmOnlineOrderPrinted(venueId, orderId, deviceId) })
  } catch (e) {
    return next(e)
  }
}
