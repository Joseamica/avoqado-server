/**
 * Bandeja «Pedidos en línea» del restaurante. Vive en `/mobile` porque quien decide está en la tablet; el panel reutiliza
 * estos mismos manejadores bajo `/dashboard`. R13: late quien manda `x-online-orders-tray: 1` (la bandeja del panel y, desde D662,
 * el POS de ANDROID o WINDOWS a la vista en CUALQUIER pantalla: su vigilante global).
 *
 * `:orderId` es SIEMPRE el id de la cuenta (`Order.id`, el `orderId` de la bandeja), nunca `onlineOrderId`.
 * R1: ninguna transición recibe `now` desde aquí: la transición toma su reloj DESPUÉS del candado de la orden.
 */
import type { NextFunction, Request, Response } from 'express'
import { OnlineOrderStatus, type OnlineOrderRejectReason } from '@prisma/client'
import { evaluateRolePermission, resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { ONLINE_ORDERS_TO_PAY_HEADER, ONLINE_ORDERS_TRAY_HEADER, TO_PAY_FAST_POLL_SECONDS } from '@/services/online-ordering/constants'
import { CARD_ALERT_HEADER, touchCardAlertPoll } from '@/services/online-ordering/cardAlertPresence'
import { MENSAJE_ABRIR_DESDE_LA_CAJA, mensajeNoSeEntrega } from '@/services/online-ordering/card/guards'
import { listInbox, type InboxFilter } from '@/services/online-ordering/inbox.service'
import { listFolios, type FolioSection } from '@/services/online-ordering/folios.service'
import { listDeliveryCashPending } from '@/services/delivery-channels/core/deliveryCashPending.service'
import { getAcceptingStatus, storeView, touchInboxPoll, touchToPayPoll } from '@/services/online-ordering/presence.service'
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
/** M-10: con tope de largo; termina guardado en `printClaimedBy`. */
const deviceOf = (req: Request): string => (req.header('x-device-id') ?? '').trim().slice(0, 100)

/**
 * D661 (Ruling 71, texto de la ronda codex-r3): el pedido ya se cerró («No lo recogió», «Devolviendo…» o «Devuelto»). Neutro a propósito:
 * uno que una persona entregó y se devolvió después también llega aquí, y «se cerró sin entregarse» no sería exacto.
 */
const CERRADO_SIN_ENTREGAR = 'Este pedido ya se cerró (se devolvió o no lo recogieron). No lo entregues.'

/** `accion`: lo que la caja pidió, para decir por qué no se aplicó («entregado» o, D661 Task 5, «listo»). */
function reply(res: Response, r: TransitionResult, accion: 'entregado' | 'listo' = 'entregado') {
  switch (r.outcome) {
    case 'OK': {
      const { outcome: _o, ...data } = r
      return res.json({ success: true, data })
    }
    case 'STALE': {
      // D661 (Task 4): al entregar o marcar «Listo», el estado real («No lo recogió», «Devolviendo…», «Devuelto») va en campos nuevos
      // opcionales. D661 (Ruling 71): un POS o una TPV viejos leen `ORDER_STATE_CHANGED` + COMPLETED en «Entregado» como el segundo
      // toque (éxito); un COMPLETED con cualquiera de esas marcas ya se cerró y lleva su PROPIO código, con el estado y las marcas de
      // siempre. Todo lo demás (un COMPLETED sin marcas incluido), el 409 de siempre.
      const { outcome: _o, status, ...marcas } = r
      const cerradoSinEntregar =
        status === OnlineOrderStatus.COMPLETED && Boolean(marcas.notPickedUpAt || marcas.refundRequestedAt || marcas.refundedAt)
      return res.status(409).json({
        success: false,
        code: cerradoSinEntregar ? 'ORDER_CLOSED_NOT_DELIVERED' : 'ORDER_STATE_CHANGED',
        status,
        ...marcas,
        error: cerradoSinEntregar
          ? CERRADO_SIN_ENTREGAR
          : (mensajeNoSeEntrega(marcas, accion) ??
            'El pedido ya cambió de estado (otro aparato, el cliente, la caja o el tiempo). Actualiza la bandeja.'),
      })
    }
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
    case 'CONFIRMING_PAYMENT':
      return res.status(409).json({
        success: false,
        code: 'ONLINE_ORDER_CONFIRMING_PAYMENT',
        error: 'Confirmando el pago con el banco. Espera unos segundos.',
      })
    case 'OPEN_FROM_CAJA':
      return res.status(409).json({ success: false, code: 'OPEN_FROM_CAJA', error: MENSAJE_ABRIR_DESDE_LA_CAJA })
    default:
      // Un resultado que este mapa no conoce es un error del servidor (500), nunca un «no existe» que engañe a la caja.
      throw new Error(`Resultado de transición desconocido: ${String((r as { outcome?: unknown }).outcome)}`)
  }
}

/**
 * H3 (r2): ¿quien consulta tiene `permission` EFECTIVO en ESTE negocio? Misma resolución que `checkPermission` (rol en el negocio +
 * lista propia o permisos personalizados); la consulta del rol ya está memoizada en `req` por el `checkPermission` de la ruta.
 * Suplantando, `userId` es el suplantado pero la sesión es de sólo lectura: no puede contestar ni cobrar, así que no late.
 */
async function canDo(req: Request, venueId: string, permission: string): Promise<boolean> {
  if ((req as any).authContext?.isImpersonating) return false
  const userId: string | undefined = (req as any).authContext?.userId
  if (!userId) return false
  const { role, permissionSet } = await resolveUserRoleForVenue({ userId, targetVenueId: venueId, req })
  return role ? evaluateRolePermission({ venueId, role, permissionSet, permission }) : false
}
const canAnswerOrders = (req: Request, venueId: string) => canDo(req, venueId, 'orders:update')

export const inbox = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const filter = ((req.query.status as InboxFilter | undefined) ?? 'all') as InboxFilter
    // A8: el Zod de la ruta ya validó el cursor (y que sólo venga con `status=active`).
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
    const data = await listInbox({ venueId, filter, ...(cursor ? { activeCursor: cursor } : {}) })
    // R13: el latido va DESPUÉS de listar bien (una bandeja que falla no mantiene abierta la tienda) y sólo con la app a la vista
    // (D662: también el POS en cualquier pantalla). H3: y sólo de quien puede contestar; un lector mira sin mantener abierta la tienda. Nunca le
    // cuesta la lista al restaurante.
    const latido = req.header(ONLINE_ORDERS_TRAY_HEADER) === '1' && (await canAnswerOrders(req, venueId).catch(() => false))
    if (latido) await touchInboxPoll(venueId).catch(() => false)
    // R13: el restaurante ve si su tienda está abierta, pausada, fuera de horario o sin aparato; 1b: y hasta cuándo, o si la
    // pausa es la del gerente (`manualPause`, que no se va sola).
    const state = await getAcceptingStatus(venueId).catch(() => null)
    return res.json({ success: true, data: { ...data, store: state ? storeView(state) : null } })
  } catch (e) {
    return next(e)
  }
}

/**
 * Tienda híbrida (T12): «Por pagar» y «Por entregar». El latido (`x-online-orders-to-pay: 1`) dice a la tienda que hay una caja viva y
 * sólo cuenta de quien puede COBRAR (`payments:create`, no suplantando); sin la cabecera no late, y el panel nunca la manda.
 * D661 (r4 #4, Ruling 7): la caja actualizada que sabe avisar los pedidos pagados en línea manda además `x-online-orders-card-alert: 1`;
 * su latido sólo cuenta de quien puede ABRIRLOS (`orders:update`) y dice si la respuesta que recibe es RÁPIDA. Va DESPUÉS del de
 * folios, que es el que crea la fila de ajustes (éste sólo la actualiza).
 */
const makeToPay = (puedeLatir: boolean) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const section = typeof req.query.section === 'string' ? (req.query.section as FolioSection) : undefined
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
    const data = await listFolios({ venueId, ...(section ? { section } : {}), ...(cursor ? { cursor } : {}) })
    const latido =
      puedeLatir && req.header(ONLINE_ORDERS_TO_PAY_HEADER) === '1' && (await canDo(req, venueId, 'payments:create').catch(() => false))
    if (latido) await touchToPayPoll(venueId).catch(() => false)
    // D661 (A, Ruling 41): la caja que avisa sólo se duerme (600 s) si su respuesta lenta quedó anotada: esa escritura apaga la marca
    // rápida con la que la tienda ofrece la tarjeta. Si la base no dejó anotarla (ni leer si esta sesión puede abrir pedidos), se le
    // contesta la cadencia rápida y sigue en 30 s hasta que se anote. Con una respuesta rápida un fallo no cambia nada (ya es 30).
    const anotada =
      !(puedeLatir && req.header(CARD_ALERT_HEADER) === '1') ||
      (await canAnswerOrders(req, venueId)
        .then(puede => (puede ? touchCardAlertPoll(venueId, data.pollSeconds <= TO_PAY_FAST_POLL_SECONDS) : false))
        .then(
          () => true,
          () => false,
        ))
    const state = await getAcceptingStatus(venueId).catch(() => null)
    return res.json({
      success: true,
      data: { ...data, ...(anotada ? {} : { pollSeconds: TO_PAY_FAST_POLL_SECONDS }), store: state ? storeView(state) : null },
    })
  } catch (e) {
    return next(e)
  }
}

/** Apps (TPV y POS): la lista con latido. */
export const toPay = makeToPay(true)
/** Panel: la MISMA lista, pero el servidor nunca lo cuenta como caja viva (no lee la cabecera), esté o no en CORS. */
export const toPayPanel = makeToPay(false)

/** Rappi 2b: los pedidos de plataforma que la caja cobra en efectivo (venta, propina y lo de la plataforma, en centavos). */
export const deliveryCash = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
    return res.json({
      success: true,
      data: await listDeliveryCashPending({ venueId: req.params.venueId, ...(cursor !== undefined ? { cursor } : {}) }),
    })
  } catch (e) {
    return next(e)
  }
}

/**
 * D661: abrir un pedido pagado con tarjeta en «Nadie» lo COBRA, y sólo lo hace una caja actualizada: por sus rutas (`desdeCaja`) y con
 * `{ abrirPagadoEnLinea: true }`. El panel nunca abre (aunque mande el campo); una app vieja (sin el campo) recibe 409 OPEN_FROM_CAJA.
 */
const makeAccept = (desdeCaja: boolean) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const estimatedMinutes = typeof req.body?.estimatedMinutes === 'number' ? req.body.estimatedMinutes : undefined
    const abrir = desdeCaja && req.body?.abrirPagadoEnLinea === true
    const r = await acceptOnlineOrder({
      venueId,
      orderId,
      staffId: staffOf(req),
      estimatedMinutes,
      ...(abrir ? { abrirPagadoEnLinea: true as const } : {}),
    })
    // Aceptar sólo puede exigir pago en un folio (QR o liga): se cobra antes de prepararlo.
    if (r.outcome === 'PAYMENT_REQUIRED') {
      return res.status(409).json({ success: false, code: 'PAYMENT_REQUIRED', error: 'Este pedido se cobra antes de prepararlo' })
    }
    return reply(res, r)
  } catch (e) {
    return next(e)
  }
}

/** Apps (TPV y POS): aceptar, y abrir un pedido pagado con tarjeta en «Nadie». */
export const accept = makeAccept(true)
/** Panel: la MISMA aceptación, pero nunca abre (cobra) un pedido pagado con tarjeta en «Nadie». */
export const acceptPanel = makeAccept(false)

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
    return reply(res, await markOnlineOrderReady({ venueId, orderId, staffId: staffOf(req) }), 'listo')
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

/** R12: se frena la tienda 15/30/60 minutos o se reanuda (`minutes: null`). Permiso `online-orders:pause` (founder, 16-oct). */
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
    // D661 (F1, Ruling 37): la caja que marca «POSIBLE REPETIDA» lo dice con la cabecera de los avisos de tarjeta.
    const marcaRepetida = req.header(CARD_ALERT_HEADER) === '1'
    return res.json({ success: true, data: await claimOnlineOrderPrint(venueId, orderId, deviceId, new Date(), marcaRepetida) })
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
